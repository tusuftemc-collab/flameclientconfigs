// Config bulutunu Turso (SQL) backend'i ile uctan uca dogrular. Turso'nun HTTP protokolu (Hrana v2
// /v2/pipeline) gomulu node:sqlite ile taklit edilir — ag yok, gercek SQL.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';

process.env.TURSO_DATABASE_URL = 'libsql://fake-db.turso.local';
process.env.TURSO_AUTH_TOKEN = 'tok';
process.env.UPLOAD_KEY = 'up-key';
process.env.STRIKE_LIMIT = '100000';

const db = new DatabaseSync(':memory:');
const cell = (v) => (v == null ? { type: 'null' } : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }) : { type: 'text', value: String(v) });
const arg = (a) => (a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.type === 'float' ? Number(a.value) : a.value);

let httpCalls = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.endsWith('/v2/pipeline')) throw new Error('unexpected fetch ' + u);
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.ok(u.startsWith('https://fake-db.turso.local'), 'libsql:// -> https://');
  httpCalls++;
  const { requests } = JSON.parse(init.body);
  const results = requests.map((r) => {
    if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
    try {
      const st = db.prepare(r.stmt.sql);
      const args = (r.stmt.args || []).map(arg);
      const isRead = /^\s*select/i.test(r.stmt.sql) || /returning/i.test(r.stmt.sql);
      if (isRead) {
        const rows = st.all(...args).map((o) => Object.values(o).map(cell));
        return { type: 'ok', response: { type: 'execute', result: { cols: [], rows, affected_row_count: 0 } } };
      }
      const info = st.run(...args);
      return { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: Number(info.changes) } } };
    } catch (e) {
      return { type: 'error', error: { message: e.message } };
    }
  });
  return new Response(JSON.stringify({ results }), { status: 200 });
};

const { default: handler } = await import('../api/config.js');

let ipSeq = 0;
async function call(method, url, { body, headers = {} } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.url = url;
  req.headers = { 'x-forwarded-for': '10.1.0.' + (++ipSeq % 250), ...headers };
  let status = 0, payload = '';
  const res = { statusCode: 200, setHeader() {}, end(s) { payload = s; status = this.statusCode; } };
  await handler(req, res);
  return { status, json: payload ? JSON.parse(payload) : null };
}

let n = 0;
const pass = (m) => console.log(`PASS ${++n}. ${m}`);
const CFG = { server: { name: 'Hypixel', ip: 'mc.hypixel.net' }, AutoTotem: { enabled: true, delay: 2 }, Island: { enabled: false } };

// 1. Yukleme anahtari zorunlu
{
  const r = await call('POST', '/api/config', { body: { name: 'x', config: CFG } });
  assert.equal(r.status, 401);
  pass('upload without the key is refused');
}

// 2. Public config yukle -> kod; ayni config tekrar -> ayni kod
let code, owner;
{
  const r = await call('POST', '/api/config', { body: { name: 'PvP Setup', config: CFG, visibility: 'public' }, headers: { 'x-flame-key': 'up-key' } });
  assert.ok(r.status === 201 || r.status === 200, 'status ' + r.status + ' ' + JSON.stringify(r.json));
  code = r.json.code; owner = r.json.owner;
  assert.ok(code && owner);
  const again = await call('POST', '/api/config', { body: { name: 'PvP Setup', config: CFG, visibility: 'public' }, headers: { 'x-flame-key': 'up-key' } });
  assert.equal(again.json.code, code);
  pass('public upload returns a code; re-uploading the same config returns the same code');
}

// 3. Kodla getir (public -> indirme sayaci artar, ayni IP gunde bir kez)
{
  const r = await call('GET', '/api/config?code=' + code);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.name, 'PvP Setup');
  assert.equal(r.json.server, 'Hypixel');
  assert.deepEqual(r.json.config.AutoTotem, CFG.AutoTotem);
  assert.equal(r.json.visibility, 'public');
  pass('lookup by code returns the full config');
}

// 4. Bilinmeyen / bozuk kod
{
  assert.equal((await call('GET', '/api/config?code=' + 'A'.repeat(code.length))).status, 404);
  assert.equal((await call('GET', '/api/config?code=bad!')).status, 400);
  pass('unknown code -> 404, malformed code -> 400');
}

// 5. Private config listede gorunmez ama koduyla acilir
let privCode;
{
  const cfg2 = { ...CFG, Hidden: { enabled: true } };
  const r = await call('POST', '/api/config', { body: { name: 'Secret', config: cfg2, visibility: 'private' }, headers: { 'x-flame-key': 'up-key' } });
  privCode = r.json.code;
  assert.equal((await call('GET', '/api/config?code=' + privCode)).json.visibility, 'private');
  pass('private config opens by code');
}

// 6. Public liste (top + new): yalnizca public olan, indirme sayisiyla
{
  const top = await call('GET', '/api/config?list=public&sort=top&page=0');
  assert.equal(top.status, 200, JSON.stringify(top.json));
  const codes = top.json.items.map((i) => i.code);
  assert.ok(codes.includes(code));
  assert.ok(!codes.includes(privCode), 'private never listed');
  const item = top.json.items.find((i) => i.code === code);
  assert.equal(item.downloads, 1, 'download counted once');
  const neu = await call('GET', '/api/config?list=public&sort=new&page=0');
  assert.ok(neu.json.items.some((i) => i.code === code));
  pass('public list (top/new) shows public configs with download counts, never private ones');
}

// 7. Sahibi kendi kodunun ustune yazar; baskasi yazamaz
{
  const cfg3 = { ...CFG, AutoTotem: { enabled: true, delay: 5 } };
  const mine = await call('POST', '/api/config', { body: { name: 'PvP Setup v2', config: cfg3, visibility: 'public', code, owner }, headers: { 'x-flame-key': 'up-key' } });
  assert.equal(mine.json.code, code);
  assert.equal((await call('GET', '/api/config?code=' + code)).json.config.AutoTotem.delay, 5);
  const thief = await call('POST', '/api/config', { body: { name: 'hijack', config: CFG, visibility: 'public', code, owner: 'wrong' }, headers: { 'x-flame-key': 'up-key' } });
  assert.notEqual(thief.json.code, code, 'wrong owner gets a new code, never overwrites');
  pass('owner overwrites their own code in place; a wrong owner token cannot');
}

assert.ok(httpCalls > 0);
console.log(`\ncloud on Turso: ${n} checks passed (${httpCalls} SQL pipelines).`);
