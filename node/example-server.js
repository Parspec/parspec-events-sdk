// Minimal receiver: PARSPEC_API_KEY=... PARSPEC_PUBLIC_KEY_FILE=key.pem node example-server.js
// Subscribe once first (the returned publicKey is what goes in the file):
//   const { publicKey } = await client.subscribe('tandemOrder.publishToErp', 1, 'https://your-host/webhook')
const http = require('http');
const fs = require('fs');
const { createClient, parseEvent, SignatureError } = require('./index.js');

const client = createClient({ apiKey: process.env.PARSPEC_API_KEY, environment: process.env.PARSPEC_ENV || 'sandbox' });
const publicKey = fs.readFileSync(process.env.PARSPEC_PUBLIC_KEY_FILE, 'utf8');
const seen = new Set();   // use your database in production: dedup must survive restarts

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let parsed;
    try { parsed = parseEvent(Buffer.concat(chunks), req.headers, publicKey); }
    catch (e) { res.writeHead(e instanceof SignatureError ? 401 : 400).end(); return; }
    res.writeHead(200).end();   // acknowledge first, work after
    const { event, transactionId } = parsed;
    if (seen.has(transactionId)) return;
    seen.add(transactionId);
    try {
      const orderId = `SO-${transactionId.slice(0, 8)}`;   // your ERP call goes here
      await client.callback(event, { orderId });
    } catch (e) {
      await client.fail(event, e.message).catch(console.error);
    }
  });
}).listen(process.env.PORT || 3000);
