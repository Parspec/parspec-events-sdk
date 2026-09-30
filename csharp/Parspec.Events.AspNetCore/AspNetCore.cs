// Parspec.Events.AspNetCore: mount the receiver at a route and it does the rest.
//
//   app.MapParspecWebhook("/parspec/webhook", receiver);
//
// Reads the raw body (a parsed body cannot be verified), answers PM, then runs the event's function.
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Parspec.Events.AspNetCore;

public static class ReceiverAspNetCore
{
    const int MaxBody = 5 << 20;

    /// <summary>Maps POST <paramref name="pattern"/> to the receiver.</summary>
    public static IEndpointConventionBuilder MapParspecWebhook(this IEndpointRouteBuilder app, string pattern, Receiver receiver) =>
        app.MapPost(pattern, receiver.HandleHttpAsync);

    /// <summary>A RequestDelegate for any pipeline: answers PM, then runs the event's function.</summary>
    public static async Task HandleHttpAsync(this Receiver receiver, HttpContext http)
    {
        if (!HttpMethods.IsPost(http.Request.Method)) { http.Response.StatusCode = 405; http.Response.Headers.Allow = "POST"; return; }
        if (http.Request.ContentLength > MaxBody) { http.Response.StatusCode = 413; return; }
        using var body = new MemoryStream();
        var buffer = new byte[81920];
        int n;
        while ((n = await http.Request.Body.ReadAsync(buffer, http.RequestAborted)) > 0)
        {
            if (body.Length + n > MaxBody) { http.Response.StatusCode = 413; return; }
            body.Write(buffer, 0, n);
        }
        var headers = http.Request.Headers;
        // No RequestAborted here: the token flows into Process, and PM closing the finished connection
        // must not cancel the event's function.
        var r = await receiver.AcceptAsync(body.ToArray(), headers["X-Signature"].FirstOrDefault(), headers["Idempotency-Key"].FirstOrDefault());
        http.Response.StatusCode = r.Status;
        http.Response.ContentLength = 0;
        await http.Response.CompleteAsync();   // PM has its answer; the work below doesn't hold the connection
        await r.Process();
    }
}
