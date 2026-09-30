// Receiver: register a function per event type; the SDK verifies, routes, dedupes and calls back.
//
// Storage is yours. Implement IKeyStore (read-only: env vars, a keychain, a secrets manager) or
// IWritableKeyStore (so SubscribeAsync can save new keys), and ITransactionStore: a database row or
// Redis SET NX in production, so claims survive restarts and span servers. MemoryKeyStore and
// MemoryTransactionStore are the in-process versions, for development.
using System.Collections.Concurrent;

namespace Parspec.Events;

public interface IKeyStore
{
    /// <summary>Every event type's current public key (PEM).</summary>
    ValueTask<IReadOnlyDictionary<string, string>> GetAsync(CancellationToken ct = default);
}

public interface IWritableKeyStore : IKeyStore
{
    ValueTask SetAsync(string eventType, string publicKeyPem, CancellationToken ct = default);
}

public interface ITransactionStore
{
    /// <summary>Atomically claim a transaction: false when it is done or another worker holds it.</summary>
    ValueTask<bool> ClaimAsync(string transactionId, CancellationToken ct = default);
    ValueTask DoneAsync(string transactionId, CancellationToken ct = default);
    /// <summary>Give the claim back so a redelivery can retry.</summary>
    ValueTask ReleaseAsync(string transactionId, CancellationToken ct = default);
}

public sealed class MemoryKeyStore(IDictionary<string, string>? initial = null) : IWritableKeyStore
{
    readonly ConcurrentDictionary<string, string> _keys = new(initial ?? new Dictionary<string, string>());

    public ValueTask<IReadOnlyDictionary<string, string>> GetAsync(CancellationToken ct = default) =>
        ValueTask.FromResult<IReadOnlyDictionary<string, string>>(new Dictionary<string, string>(_keys));

    public ValueTask SetAsync(string eventType, string publicKeyPem, CancellationToken ct = default)
    {
        _keys[eventType] = publicKeyPem;
        return ValueTask.CompletedTask;
    }
}

/// <summary>lease: a claim older than this counts as abandoned (the worker died), so a redelivery can take it.</summary>
public sealed class MemoryTransactionStore(TimeSpan? lease = null) : ITransactionStore
{
    readonly TimeSpan _lease = lease ?? TimeSpan.FromMinutes(15);
    readonly object _lock = new();
    readonly Dictionary<string, DateTime> _processing = new();
    readonly HashSet<string> _done = new();

    public ValueTask<bool> ClaimAsync(string transactionId, CancellationToken ct = default)
    {
        lock (_lock)
        {
            if (_done.Contains(transactionId)) return ValueTask.FromResult(false);
            if (_processing.TryGetValue(transactionId, out var at) && DateTime.UtcNow - at < _lease) return ValueTask.FromResult(false);
            _processing[transactionId] = DateTime.UtcNow;
            return ValueTask.FromResult(true);
        }
    }

    public ValueTask DoneAsync(string transactionId, CancellationToken ct = default)
    {
        lock (_lock) { _processing.Remove(transactionId); _done.Add(transactionId); }
        return ValueTask.CompletedTask;
    }

    public ValueTask ReleaseAsync(string transactionId, CancellationToken ct = default)
    {
        lock (_lock) _processing.Remove(transactionId);
        return ValueTask.CompletedTask;
    }
}

public sealed record EventContext(string EventType, string TransactionId, string? IdempotencyKey);

/// <summary>The result of AcceptAsync: answer PM with Status now, then await Process().</summary>
public sealed record Accepted(int Status, Func<Task> Process, string? EventType = null, string? TransactionId = null, bool Duplicate = false);

/// <summary>Handler: return the callback fields (or null, for a plain acknowledgement). Throwing sends an
/// error callback with the message, which PM shows to the user.</summary>
public delegate Task<IDictionary<string, object?>?> ParspecEventHandler(ParsedEvent evt, EventContext ctx, CancellationToken ct);

public sealed class Receiver(ParspecClient client, IKeyStore? keys = null, ITransactionStore? transactions = null, Action<Exception, EventContext>? onError = null)
{
    static readonly Func<Task> Noop = () => Task.CompletedTask;
    readonly IKeyStore _keys = keys ?? new MemoryKeyStore();
    readonly ITransactionStore _transactions = transactions ?? new MemoryTransactionStore();
    readonly Action<Exception, EventContext> _onError = onError ?? ((_, _) => { });
    readonly Dictionary<string, (ParspecEventHandler Handler, int Version)> _handlers = new();

    public Receiver On(string eventType, ParspecEventHandler handler, int version = 1)
    {
        ArgumentNullException.ThrowIfNull(handler);
        _handlers[eventType] = (handler, version);
        return this;
    }

    public Receiver On(string eventType, Func<ParsedEvent, EventContext, Task<IDictionary<string, object?>?>> handler, int version = 1)
    {
        ArgumentNullException.ThrowIfNull(handler);
        return On(eventType, (e, c, _) => handler(e, c), version);
    }

    /// <summary>Subscribe every registered event. New keys are saved when the key store is writable, and
    /// always returned, for stores you manage yourself.</summary>
    public async Task<IReadOnlyDictionary<string, string>> SubscribeAsync(string webhookUrl, CancellationToken ct = default)
    {
        var minted = new Dictionary<string, string>();
        foreach (var (eventType, (_, version)) in _handlers)
        {
            minted[eventType] = (await client.SubscribeAsync(eventType, version, webhookUrl, ct).ConfigureAwait(false)).PublicKey;
            if (_keys is IWritableKeyStore w) await w.SetAsync(eventType, minted[eventType], ct).ConfigureAwait(false);
        }
        return minted;
    }

    /// <summary>Phase 1, fast: verify, parse, claim.</summary>
    public async Task<Accepted> AcceptAsync(byte[] rawBody, string? signature, string? idempotencyKey = null, CancellationToken ct = default)
    {
        var stored = await _keys.GetAsync(ct).ConfigureAwait(false);
        var match = stored.FirstOrDefault(kv => Signature.Verify(rawBody, signature, kv.Value));
        if (match.Key is null) return new Accepted(401, Noop);
        ParsedEvent evt;
        try { evt = Signature.ParseEvent(rawBody, signature, match.Value, idempotencyKey); }
        catch (EventException) { return new Accepted(400, Noop); }
        if (!await _transactions.ClaimAsync(evt.TransactionId, ct).ConfigureAwait(false))
            return new Accepted(200, Noop, match.Key, evt.TransactionId, Duplicate: true);
        var ctx = new EventContext(match.Key, evt.TransactionId, idempotencyKey);
        return new Accepted(200, () => RunAsync(evt, ctx, ct), match.Key, evt.TransactionId);
    }

    // Phase 2: the handler, one callback, and the claim settled (done, or released so a redelivery retries).
    async Task RunAsync(ParsedEvent evt, EventContext ctx, CancellationToken ct)
    {
        IDictionary<string, object?>? fields = null;
        Exception? failure = null;
        try
        {
            if (_handlers.TryGetValue(ctx.EventType, out var registered))
                fields = await registered.Handler(evt, ctx, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested) { failure = e; }
        try
        {
            if (failure is not null) await client.FailAsync(evt, failure.Message, null, ct).ConfigureAwait(false);
            else await client.CallbackAsync(evt, fields, ct).ConfigureAwait(false);
        }
        catch (ParspecApiException e)
        {
            await _transactions.ReleaseAsync(ctx.TransactionId, ct).ConfigureAwait(false);
            _onError(e, ctx);
            return;
        }
        if (failure is not null)
        {
            await _transactions.ReleaseAsync(ctx.TransactionId, ct).ConfigureAwait(false);
            _onError(failure, ctx);
        }
        else await _transactions.DoneAsync(ctx.TransactionId, ct).ConfigureAwait(false);
    }

    /// <summary>Both phases in one call; returns the status to answer PM with.</summary>
    public async Task<int> HandleAsync(byte[] rawBody, string? signature, string? idempotencyKey = null, CancellationToken ct = default)
    {
        var r = await AcceptAsync(rawBody, signature, idempotencyKey, ct).ConfigureAwait(false);
        await r.Process().ConfigureAwait(false);
        return r.Status;
    }
}
