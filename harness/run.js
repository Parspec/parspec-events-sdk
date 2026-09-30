#!/usr/bin/env node
// Conformance harness: runs every language SDK through the same checks.
//
//   node harness/run.js fixtures                  each language's unit tests (fixtures/)
//   node harness/run.js replay --events <dir>     recorded deliveries through all four SDKs
//   node harness/run.js live --events a,b,c       a real org, end to end (see harness/README.md)
//   node harness/run.js live --fake               the same flow against a local fake PM (no network)
//
// Options: --only node,python,csharp,java   limit the languages
//
// The SDKs are driven through adapters (harness/adapters/*), small programs that take one JSON
// request on stdin and print one JSON reply. No dependencies beyond the four toolchains.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(__dirname, '.build');
const LANGS = ['node', 'python', 'csharp', 'java'];

// Payload versions the org subscribes with; everything else is v1. Override per event with type:version.
const V2 = new Set(['inventory.fetchPrice', 'quote.created', 'quote.updated', 'quote.publishToOrderSystem', 'bom.publishToOrderSystem']);

const args = process.argv.slice(2);
const mode = args[0];
const opt = name => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const flag = name => args.includes(`--${name}`);
const langs = (opt('only') || LANGS.join(',')).split(',');

// JAVA_HOME, then the Homebrew keg (keg-only, and macOS's /usr/bin/java is a stub with no JDK
// behind it), then PATH.
const javaBin = tool => {
  if (process.env.JAVA_HOME) return path.join(process.env.JAVA_HOME, 'bin', tool);
  const keg = `/opt/homebrew/opt/openjdk@21/bin/${tool}`;
  return fs.existsSync(keg) ? keg : tool;
};

function sh(cmd, argv, { input, cwd = ROOT, quiet = false } = {}) {
  return new Promise(resolve => {
    const p = spawn(cmd, argv, { cwd });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; if (!quiet && input === undefined) process.stdout.write(d); });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => resolve({ code: 127, out, err: e.message }));
    p.on('close', code => resolve({ code, out, err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

const ADAPTERS = {
  node: () => ['node', [path.join(__dirname, 'adapters/node.js')]],
  python: () => ['python3', [path.join(__dirname, 'adapters/python.py')]],
  csharp: () => ['dotnet', [path.join(BUILD, 'csharp/Adapter.dll')]],
  java: () => [javaBin('java'), ['-cp', path.join(BUILD, 'java'), 'com.parspec.events.Cli']],
};

async function buildAdapters() {
  if (langs.includes('csharp')) {
    const r = await sh('dotnet', ['build', path.join(__dirname, 'adapters/csharp'), '-v', 'q', '-nologo', '-o', path.join(BUILD, 'csharp')], { quiet: true });
    if (r.code) throw new Error(`C# adapter build failed:\n${r.out}${r.err}`);
  }
  if (langs.includes('java')) {
    fs.rmSync(path.join(BUILD, 'java'), { recursive: true, force: true });
    const sources = [...walk(path.join(ROOT, 'java/src/main/java')), ...walk(path.join(__dirname, 'adapters/java'))].filter(f => f.endsWith('.java'));
    const r = await sh(javaBin('javac'), ['--release', '17', '-nowarn', '-d', path.join(BUILD, 'java'), ...sources], { quiet: true });
    if (r.code) throw new Error(`Java adapter build failed:\n${r.out}${r.err}`);
  }
}

async function call(lang, request) {
  const [cmd, argv] = ADAPTERS[lang]();
  const r = await sh(cmd, argv, { input: JSON.stringify(request) });
  let value;
  try { value = JSON.parse(r.out); } catch { value = { error: (r.out + r.err).slice(0, 500) || `exit ${r.code}` }; }
  return r.code === 0 ? { ok: true, value } : { ok: false, error: value.error, status: value.status };
}

// Same JSON regardless of key order.
const canon = v => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// Collects callbacks the SDKs send, standing in for PM.
function fakePm() {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, apiKey: req.headers['x-api-key'], body: JSON.parse(Buffer.concat(chunks)) });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, got, base: `http://127.0.0.1:${server.address().port}/platform-api/api/v1/` })));
}

function report(rows) {
  let failed = 0;
  for (const [lang, checks] of Object.entries(rows)) {
    const line = Object.entries(checks).map(([name, c]) => `${name} ${c.pass}/${c.total}`).join('   ');
    console.log(`${lang.padEnd(7)} ${line}`);
    for (const c of Object.values(checks)) for (const f of c.failures.slice(0, 5)) console.log(`         ✗ ${f}`);
    failed += Object.values(checks).reduce((n, c) => n + c.total - c.pass, 0);
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  return failed;
}

const tally = () => ({ pass: 0, total: 0, failures: [] });
const check = (t, ok, why) => { t.total++; if (ok) t.pass++; else t.failures.push(why); };

// ---- fixtures: each language's own unit tests ----
async function fixtures() {
  const suites = {
    node: ['node', ['--test', 'test.js'], path.join(ROOT, 'node')],
    python: ['python3', ['-m', 'unittest'], path.join(ROOT, 'python')],
    csharp: ['dotnet', ['run', '--project', path.join(ROOT, 'csharp/Parspec.Events.Tests')], ROOT],
    java: null,
  };
  let failed = 0;
  for (const lang of langs) {
    let r;
    if (lang === 'java') {
      const out = path.join(BUILD, 'java-tests');
      fs.rmSync(out, { recursive: true, force: true });
      const sources = walk(path.join(ROOT, 'java/src')).filter(f => f.endsWith('.java'));
      r = await sh(javaBin('javac'), ['--release', '17', '-nowarn', '-d', out, ...sources], { quiet: true });
      if (!r.code) r = await sh(javaBin('java'), ['-cp', out, 'com.parspec.events.FixturesTest'], { cwd: path.join(ROOT, 'java'), quiet: true });
    } else {
      const [cmd, argv, cwd] = suites[lang];
      r = await sh(cmd, argv, { cwd, quiet: true });
    }
    const ok = r.code === 0;
    if (!ok) failed++;
    console.log(`${lang.padEnd(7)} ${ok ? 'pass' : 'FAIL'}`);
    if (!ok) console.log((r.out + r.err).split('\n').filter(l => /fail|error|✖|Error/i.test(l)).slice(0, 10).map(l => '         ' + l).join('\n'));
  }
  console.log(failed ? `\n${failed} language(s) failed` : '\nall languages passed');
  return failed;
}

// ---- replay: recorded deliveries (mock-erp's runtime-data/<slug> layout) ----
// <dir>/events/*.json are delivered envelopes; <dir>/callbacks/<first 8 of txid>.json {sent} is the
// callback the receiver sent for it. Each SDK must verify the body, reject a tampered copy and a
// wrong key, and send the same callback. The bodies are re-signed with a throwaway key: recordings
// keep the parsed event, not PM's signature (live mode covers real signatures).
async function replay() {
  const dir = opt('events');
  if (!dir) throw new Error('replay needs --events <dir> (e.g. mock-erp runtime-data/<slug>)');
  const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer = pair();
  const pem = signer.publicKey.export({ type: 'spki', format: 'pem' });
  const otherPem = pair().publicKey.export({ type: 'spki', format: 'pem' });
  const sign = buf => crypto.sign('RSA-SHA256', buf, signer.privateKey).toString('base64');

  const cases = fs.readdirSync(path.join(dir, 'events')).filter(f => f.endsWith('.json')).sort().map(f => {
    const event = JSON.parse(fs.readFileSync(path.join(dir, 'events', f)));
    const cbFile = path.join(dir, 'callbacks', `${String(event.eventTransactionID).slice(0, 8)}.json`);
    const sent = fs.existsSync(cbFile) ? JSON.parse(fs.readFileSync(cbFile)).sent : null;
    const { EventTransactionID, EventStatus, ...fields } = sent || {};
    const raw = Buffer.from(JSON.stringify(event));
    return { file: f, txid: event.eventTransactionID, raw, sig: sign(raw), fields: sent ? fields : {},
      expect: { ...(sent || {}), EventTransactionID: event.eventTransactionID, EventStatus: 'success' } };
  });
  const types = new Set(cases.map(c => c.file.replace(/-[^-]+\.json$/, '')));
  console.log(`${cases.length} recorded deliveries, ${types.size} event types, ${cases.filter(c => Object.keys(c.fields).length).length} with a recorded callback\n`);

  const pm = await fakePm();
  const rows = {};
  for (const lang of langs) {
    const sig = tally(), cb = tally();
    const vcases = cases.flatMap(c => [
      { body: c.raw.toString('base64'), signature: c.sig, publicKey: pem, want: true, why: `${c.file}: real body did not verify` },
      { body: Buffer.from(c.raw.toString().replace('"data"', '"dat4"')).toString('base64'), signature: c.sig, publicKey: pem, want: false, why: `${c.file}: tampered body verified` },
      { body: c.raw.toString('base64'), signature: c.sig, publicKey: otherPem, want: false, why: `${c.file}: wrong key verified` },
    ]);
    const v = await call(lang, { op: 'verify', cases: vcases });
    vcases.forEach((c, i) => check(sig, v.ok && v.value[i] === c.want, v.ok ? c.why : `adapter: ${v.error}`));

    pm.got.length = 0;
    const r = await call(lang, { op: 'callback', apiKey: 'harness-key', base: pm.base, publicKey: pem,
      cases: cases.map(c => ({ body: c.raw.toString('base64'), signature: c.sig, fields: c.fields })) });
    for (const c of cases) {
      const g = pm.got.find(x => x.body.EventTransactionID === c.txid);
      check(cb, r.ok && g && same(g.body, c.expect) && g.url.endsWith('/integrations/events/callback') && g.apiKey === 'harness-key',
        !r.ok ? `adapter: ${r.error}` : !g ? `${c.file}: no callback` : `${c.file}: callback differs from the recorded one`);
    }
    rows[lang] = { signatures: sig, callbacks: cb };
  }
  pm.server.close();
  return report(rows);
}

// ---- live: a real org ----
async function live() {
  const fake = flag('fake') ? await require('./fake_pm.js').start(['tandemOrder.publishToErp', 'inventory.fetchPrice', 'receivingTicket.publishToErp', 'deliveryTicket.publishToErp', 'quote.created']) : null;
  if (fake && !opt('events')) args.push('--events', 'tandemOrder.publishToErp,inventory.fetchPrice,receivingTicket.publishToErp,deliveryTicket.publishToErp');
  if (fake) fake.preSubscribe('tandemOrder.publishToErp', 1);   // someone else holds it: subscribe must take it over
  const port = Number(process.env.PORT || 9477);
  const apiKey = fake ? 'fake-key' : process.env.PARSPEC_API_KEY;
  const webhookBase = fake ? `http://127.0.0.1:${port}` : (process.env.PARSPEC_WEBHOOK_URL || '').replace(/\/+$/, '');
  const base = fake ? fake.base : process.env.PARSPEC_BASE_URL || {
    production: 'https://platform.parspec.io/platform-api/api/v1/',
    sandbox: 'https://platform-sandbox.parspec.io/platform-api/api/v1/',
    preprod: 'https://uat-platform.parspec.io/platform-api/api/v1/',
  }[process.env.PARSPEC_ENV || 'sandbox'];
  const waitSec = Number(opt('wait') || (fake ? 15 : 600));
  const events = (opt('events') || '').split(',').filter(Boolean).map(e => {
    const [type, v] = e.split(':');
    return { type, version: v ? Number(v) : V2.has(type) ? 2 : 1 };
  });
  if (!apiKey || !webhookBase || !events.length) {
    throw new Error('live needs PARSPEC_API_KEY, PARSPEC_WEBHOOK_URL (public URL that reaches this machine on PORT) and --events a,b,c');
  }
  if (/platform\.parspec\.io/.test(base) && !flag('allow-production')) throw new Error('refusing production without --allow-production');

  const catalog = async () => {
    const res = await fetch(base + 'integrations/events/list', { headers: { 'x-api-key': apiKey } });
    if (res.status !== 200) throw new Error(`catalog: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return new Set(Object.keys((await res.json()).availableEvents || {}));
  };

  // Receiver: ack every POST at once, keep the raw bytes for the adapters.
  const deliveries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST') return res.writeHead(200).end('parspec sdk harness');
      res.writeHead(200).end();
      const d = { at: new Date().toISOString(), url: req.url, raw: Buffer.concat(chunks), sig: req.headers['x-signature'], idem: req.headers['idempotency-key'] };
      d.eventType = (events.find(e => req.url.endsWith(`/webhook/${e.type}`)) || {}).type || null;
      deliveries.push(d);
      console.log(`  ← ${d.at} ${d.eventType || req.url} (${d.raw.length} bytes)`);
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const probe = await fetch(webhookBase + '/').then(r => r.status, e => e.message);
  if (probe !== 200) { server.close(); throw new Error(`${webhookBase}/ does not reach this harness on port ${port} (got ${probe})`); }
  console.log(`receiver on 127.0.0.1:${port}, reachable at ${webhookBase}`);

  const rows = Object.fromEntries(langs.map(l => [l, { subscribe: tally(), verify: tally(), callback: tally(), unsubscribe: tally() }]));
  const owner = new Map();   // eventType -> { lang, publicKey }
  const cleanup = async () => {
    if (flag('keep')) { console.log('\n--keep: leaving subscriptions in place'); return; }
    console.log('\nunsubscribing');
    for (const [type, { lang }] of owner) {
      const r = await call(lang, { op: 'unsubscribe', base, apiKey, eventType: type });
      check(rows[lang].unsubscribe, r.ok, `${type}: ${r.error}`);
    }
    const available = await catalog();
    for (const [type, { lang }] of owner) check(rows[lang].unsubscribe, available.has(type), `${type}: still subscribed after unsubscribe`);
  };
  let interrupted = false;
  process.once('SIGINT', () => { interrupted = true; console.log('\ninterrupted — cleaning up'); });

  try {
    console.log('\nsubscribing');
    for (const [i, e] of events.entries()) {
      const lang = langs[i % langs.length];
      const r = await call(lang, { op: 'subscribe', base, apiKey, eventType: e.type, version: e.version, webhookUrl: `${webhookBase}/webhook/${e.type}` });
      check(rows[lang].subscribe, r.ok && r.value.publicKey, `${e.type}: ${r.error}`);
      if (r.ok) { owner.set(e.type, { lang, publicKey: r.value.publicKey }); console.log(`  ${lang.padEnd(7)} ${e.type} v${e.version}${r.value.replaced ? ` (replaced ${r.value.replaced})` : ''}`); }
      else console.log(`  ${lang.padEnd(7)} ${e.type} FAILED: ${r.error}`);
    }
    const available = await catalog();
    for (const [type, { lang }] of owner) check(rows[lang].subscribe, !available.has(type), `${type}: catalog still lists it as available`);

    console.log(`\nTrigger these in PM now (waiting up to ${waitSec}s, Ctrl-C to stop early):`);
    for (const [type, { lang }] of owner) console.log(`  ${type}  (subscribed by ${lang})`);
    const deadline = Date.now() + waitSec * 1000;
    while (!interrupted && Date.now() < deadline && [...owner.keys()].some(t => !deliveries.some(d => d.eventType === t))) {
      await new Promise(r => setTimeout(r, 1000));
    }

    for (const d of deliveries) {
      const o = d.eventType && owner.get(d.eventType);
      if (!o) { console.log(`  skipping delivery to ${d.url}: not an event this run subscribed`); continue; }
      // Every language verifies PM's real signature, and rejects a tampered copy.
      const body = d.raw.toString('base64');
      const tampered = Buffer.concat([d.raw, Buffer.from(' ')]).toString('base64');
      for (const lang of langs) {
        const v = await call(lang, { op: 'verify', cases: [
          { body, signature: d.sig, publicKey: o.publicKey },
          { body: tampered, signature: d.sig, publicKey: o.publicKey }] });
        check(rows[lang].verify, v.ok && v.value[0] === true, `${d.eventType} @ ${d.at}: real signature did not verify${v.ok ? '' : ` (${v.error})`}`);
        check(rows[lang].verify, v.ok && v.value[1] === false, `${d.eventType} @ ${d.at}: tampered copy verified`);
      }
      // The subscribing language answers PM, once per transaction.
      const txid = JSON.parse(d.raw).eventTransactionID;
      if (deliveries.findIndex(x => x.raw.length && JSON.parse(x.raw).eventTransactionID === txid) !== deliveries.indexOf(d)) continue;
      const r = await call(o.lang, { op: 'callback', base, apiKey, publicKey: o.publicKey,
        cases: [{ body, signature: d.sig, fields: { metadata: { source: 'parspec-sdk-harness' } } }] });
      check(rows[o.lang].callback, r.ok, `${d.eventType} tx=${txid}: ${r.error}`);
    }
    for (const [type, { lang }] of owner) check(rows[lang].verify, deliveries.some(d => d.eventType === type), `${type}: no delivery arrived`);
    // The fake delivers every event twice with one transaction id: PM must get exactly one callback each.
    if (fake) {
      await new Promise(r => setTimeout(r, 500));
      for (const [type, { lang }] of owner) {
        const txids = new Set(deliveries.filter(d => d.eventType === type).map(d => JSON.parse(d.raw).eventTransactionID));
        const n = fake.callbacks.filter(c => txids.has(c.EventTransactionID)).length;
        check(rows[lang].callback, n === txids.size, `${type}: ${n} callbacks for ${txids.size} transaction(s)`);
      }
    }
  } finally {
    await cleanup();
    server.close();
    if (fake) fake.close();
  }
  console.log('');
  const failed = report(rows);
  if (!flag('keep') && !fake) console.log('\nThe events are now unsubscribed. Resubscribe the org\'s real receiver (for mock-erp: turn the events off and on again in the console, then Apply).');
  return failed;
}

(async () => {
  if (!['fixtures', 'replay', 'live'].includes(mode)) {
    console.log('usage: node harness/run.js fixtures | replay --events <dir> | live [--fake] --events a,b,c [--only langs] [--wait sec] [--keep]');
    process.exit(2);
  }
  if (mode !== 'fixtures') await buildAdapters();
  const failed = await { fixtures, replay, live }[mode]();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
