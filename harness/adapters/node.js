// Harness adapter: one JSON request on stdin, one JSON reply on stdout. Ops:
//   verify      {cases:[{body(b64), signature, publicKey}]}          -> [bool]
//   callback    {base, apiKey, publicKey, cases:[{body, signature, fields}]} -> [transactionId]
//   subscribe   {base, apiKey, eventType, version, webhookUrl}        -> {publicKey, replaced}
//   unsubscribe {base, apiKey, eventType, version?}                   -> [status]
// Errors: {error, status} and exit code 1. The Python, C# and Java adapters implement the same contract.
const sdk = require('../../node/index.js');

(async () => {
  const q = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const client = () => sdk.createClient({ apiKey: q.apiKey, baseUrl: q.base });
  const b = s => Buffer.from(s, 'base64');
  let out;
  if (q.op === 'verify') out = q.cases.map(c => sdk.verify(b(c.body), c.signature, c.publicKey));
  else if (q.op === 'callback') {
    out = [];
    for (const c of q.cases) {
      const { event, transactionId } = sdk.parseEvent(b(c.body), { 'X-Signature': c.signature }, q.publicKey);
      await client().callback(event, c.fields);
      out.push(transactionId);
    }
  } else if (q.op === 'subscribe') out = await client().subscribe(q.eventType, q.version, q.webhookUrl);
  else if (q.op === 'unsubscribe') out = (await client().unsubscribe(q.eventType, q.version)).map(r => r.status);
  else throw new Error(`unknown op ${q.op}`);
  process.stdout.write(JSON.stringify(out));
})().catch(e => { process.stdout.write(JSON.stringify({ error: e.message, status: e.status })); process.exitCode = 1; });
