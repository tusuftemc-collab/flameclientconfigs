// Flame V1 — Redis komutlarini SQL (Turso / libSQL) uzerinde calistiran adaptor.
//
// Neden: Upstash'in ucretsiz plan gunluk komut limiti doluyor. Turso'nun ucretsiz plani cok daha
// comert ve KART ISTEMEZ. Kodun hicbir yerindeki redis([...]) cagrilari degismez; sadece store.js'in
// redis() fonksiyonu, TURSO_* env'leri varsa bu adaptore yonlenir.
//
// Tasarim: store.js gibi YALNIZCA global fetch kullanir (edge + node), npm bagimliligi yok.
// Turso'nun HTTP protokolu (Hrana v2 /v2/pipeline) ile konusur. Her Redis komutu bir ya da birkac
// SQL ifadesine cevrilir; "plan" saf fonksiyondur, boylece node:sqlite ile ag olmadan test edilir.
//
// Veri modeli:
//   kv(k,v,exp)        string'ler (exp = epoch ms; exp<=now ise yok sayilir/silinir)
//   st(k,m)            set'ler (SADD/SREM/SMEMBERS/SISMEMBER/SCARD)
//   lst(k,seq,m)       list'ler (LPUSH onden ekler = azalan seq; index 0 = en kucuk seq)
//   zet(k,m,score)     sorted set'ler (ZADD/ZREVRANGE/ZREM)

export const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)',
  'CREATE INDEX IF NOT EXISTS kv_exp ON kv (exp)',
  'CREATE TABLE IF NOT EXISTS st (k TEXT NOT NULL, m TEXT NOT NULL, PRIMARY KEY (k, m))',
  'CREATE TABLE IF NOT EXISTS lst (k TEXT NOT NULL, seq INTEGER NOT NULL, m TEXT NOT NULL, PRIMARY KEY (k, seq))',
  'CREATE TABLE IF NOT EXISTS zet (k TEXT NOT NULL, m TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (k, m))',
];

// ---- env ----

let credsCache;
export function sqlCredentials() {
  if (credsCache !== undefined) return credsCache;
  const env = process.env;
  const url = env.TURSO_DATABASE_URL || env.LIBSQL_URL || env.TURSO_URL || '';
  const token = env.TURSO_AUTH_TOKEN || env.LIBSQL_AUTH_TOKEN || env.TURSO_TOKEN || '';
  if (!url) return (credsCache = null);
  // libsql:// -> https://  (HTTP pipeline ucu). http(s) verildiyse oldugu gibi birak.
  let http = url;
  if (http.startsWith('libsql://')) http = 'https://' + http.slice('libsql://'.length);
  http = http.replace(/\/+$/, '');
  return (credsCache = { url: http, token });
}

export function sqlReady() {
  return sqlCredentials() != null;
}

// ---- yardimcilar ----

const isInt = (n) => Number.isInteger(n);

/** Redis skorlari string doner; tam sayi ise ondaliksiz ("3", "1700000000000"). */
function fmtScore(v) {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : String(n);
}

/** Bir Redis komutunu SQL ifadelerine cevirir. { stmts:[{sql,args,read}], parse(results) } doner. */
export function plan(command, now) {
  const op = String(command[0]).toUpperCase();
  const a = command;
  switch (op) {
    case 'GET':
      return {
        stmts: [{ sql: 'SELECT v FROM kv WHERE k=? AND (exp IS NULL OR exp>?)', args: [a[1], now], read: true }],
        parse: (r) => (r[0].rows.length ? r[0].rows[0][0] : null),
      };

    case 'MGET': {
      const keys = a.slice(1);
      if (!keys.length) return { stmts: [], parse: () => [] };
      const ph = keys.map(() => '?').join(',');
      return {
        stmts: [{ sql: `SELECT k,v FROM kv WHERE k IN (${ph}) AND (exp IS NULL OR exp>?)`, args: [...keys, now], read: true }],
        parse: (r) => {
          const map = new Map(r[0].rows.map((row) => [row[0], row[1]]));
          return keys.map((k) => (map.has(k) ? map.get(k) : null));
        },
      };
    }

    case 'SET': {
      const k = a[1], v = String(a[2]);
      let nx = false, keepttl = false, exp = null;
      for (let i = 3; i < a.length; i++) {
        const o = String(a[i]).toUpperCase();
        if (o === 'NX') nx = true;
        else if (o === 'KEEPTTL') keepttl = true;
        else if (o === 'EX') exp = now + Number(a[++i]) * 1000;
        else if (o === 'PX') exp = now + Number(a[++i]);
      }
      const sweep = { sql: 'DELETE FROM kv WHERE k=? AND exp IS NOT NULL AND exp<=?', args: [k, now], read: false };
      let ins;
      if (keepttl) ins = { sql: 'INSERT INTO kv(k,v,exp) VALUES(?,?,NULL) ON CONFLICT(k) DO UPDATE SET v=excluded.v', args: [k, v], read: false };
      else if (nx) ins = { sql: 'INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO NOTHING', args: [k, v, exp], read: false };
      else ins = { sql: 'INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp', args: [k, v, exp], read: false };
      return { stmts: [sweep, ins], parse: (r) => (nx ? (r[1].affected > 0 ? 'OK' : null) : 'OK') };
    }

    case 'DEL': {
      const k = a[1];
      return {
        stmts: [
          { sql: 'DELETE FROM kv WHERE k=?', args: [k], read: false },
          { sql: 'DELETE FROM st WHERE k=?', args: [k], read: false },
          { sql: 'DELETE FROM lst WHERE k=?', args: [k], read: false },
          { sql: 'DELETE FROM zet WHERE k=?', args: [k], read: false },
        ],
        parse: (r) => (r.some((x) => x.affected > 0) ? 1 : 0),
      };
    }

    case 'INCR':
    case 'DECR':
    case 'INCRBY': {
      const k = a[1];
      const delta = op === 'INCR' ? 1 : op === 'DECR' ? -1 : Math.trunc(Number(a[2]));
      return {
        stmts: [
          { sql: 'DELETE FROM kv WHERE k=? AND exp IS NOT NULL AND exp<=?', args: [k, now], read: false },
          { sql: 'INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(kv.v AS INTEGER)+? AS INTEGER) RETURNING v', args: [k, String(delta), delta], read: true },
        ],
        parse: (r) => Number(r[1].rows[0][0]),
      };
    }

    case 'TTL':
      return {
        stmts: [{ sql: 'SELECT exp FROM kv WHERE k=?', args: [a[1]], read: true }],
        parse: (r) => {
          if (!r[0].rows.length) return -2;
          const exp = r[0].rows[0][0];
          if (exp == null) return -1;
          if (exp <= now) return -2;
          return Math.ceil((exp - now) / 1000);
        },
      };

    case 'ZADD':
      return {
        stmts: [{ sql: 'INSERT INTO zet(k,m,score) VALUES(?,?,?) ON CONFLICT(k,m) DO UPDATE SET score=excluded.score', args: [a[1], String(a[3]), Number(a[2])], read: false }],
        parse: (r) => r[0].affected,
      };

    case 'ZREM':
      return {
        stmts: [{ sql: 'DELETE FROM zet WHERE k=? AND m=?', args: [a[1], String(a[2])], read: false }],
        parse: (r) => r[0].affected,
      };

    case 'ZREVRANGE': {
      const start = Number(a[2]), stop = Number(a[3]);
      const withScores = a.some((x) => String(x).toUpperCase() === 'WITHSCORES');
      const limit = stop < 0 ? -1 : Math.max(0, stop - start + 1);
      return {
        stmts: [{ sql: 'SELECT m,score FROM zet WHERE k=? ORDER BY score DESC, m DESC LIMIT ? OFFSET ?', args: [a[1], limit, Math.max(0, start)], read: true }],
        parse: (r) => {
          const out = [];
          for (const row of r[0].rows) {
            out.push(row[0]);
            if (withScores) out.push(String(Math.trunc(Number(row[1]))));
          }
          return out;
        },
      };
    }

    case 'ZRANGE': {
      // ZRANGE key start stop [REV] [WITHSCORES] — index araligi (stop -1 = sona kadar)
      const start = Number(a[2]), stop = Number(a[3]);
      const opts = a.slice(4).map((x) => String(x).toUpperCase());
      const rev = opts.includes('REV');
      const withScores = opts.includes('WITHSCORES');
      const limit = stop < 0 ? -1 : Math.max(0, stop - Math.max(0, start) + 1);
      const order = rev ? 'score DESC, m DESC' : 'score ASC, m ASC';
      return {
        stmts: [{ sql: `SELECT m,score FROM zet WHERE k=? ORDER BY ${order} LIMIT ? OFFSET ?`, args: [a[1], limit, Math.max(0, start)], read: true }],
        parse: (r) => {
          const out = [];
          for (const row of r[0].rows) {
            out.push(row[0]);
            if (withScores) out.push(fmtScore(row[1]));
          }
          return out;
        },
      };
    }

    case 'ZSCORE':
      return {
        stmts: [{ sql: 'SELECT score FROM zet WHERE k=? AND m=?', args: [a[1], String(a[2])], read: true }],
        parse: (r) => (r[0].rows.length ? fmtScore(r[0].rows[0][0]) : null),
      };

    case 'ZMSCORE': {
      const members = a.slice(2).map(String);
      if (!members.length) return { stmts: [], parse: () => [] };
      const ph = members.map(() => '?').join(',');
      return {
        stmts: [{ sql: `SELECT m,score FROM zet WHERE k=? AND m IN (${ph})`, args: [a[1], ...members], read: true }],
        parse: (r) => {
          const map = new Map(r[0].rows.map((row) => [row[0], row[1]]));
          return members.map((m) => (map.has(m) ? fmtScore(map.get(m)) : null));
        },
      };
    }

    case 'ZINCRBY':
      return {
        stmts: [{ sql: 'INSERT INTO zet(k,m,score) VALUES(?,?,?) ON CONFLICT(k,m) DO UPDATE SET score=zet.score+excluded.score RETURNING score', args: [a[1], String(a[3]), Number(a[2])], read: true }],
        parse: (r) => fmtScore(r[0].rows[0][0]),
      };

    case 'ZCARD':
      return {
        stmts: [{ sql: 'SELECT COUNT(*) FROM zet WHERE k=?', args: [a[1]], read: true }],
        parse: (r) => Number(r[0].rows[0][0]),
      };

    case 'EXISTS': {
      const keys = a.slice(1);
      return {
        stmts: keys.map((k) => ({
          sql: 'SELECT (EXISTS(SELECT 1 FROM kv WHERE k=? AND (exp IS NULL OR exp>?)) OR EXISTS(SELECT 1 FROM st WHERE k=?) OR EXISTS(SELECT 1 FROM lst WHERE k=?) OR EXISTS(SELECT 1 FROM zet WHERE k=?))',
          args: [k, now, k, k, k], read: true,
        })),
        parse: (r) => r.reduce((n, x) => n + (Number(x.rows[0][0]) ? 1 : 0), 0),
      };
    }

    case 'SADD':
      return {
        stmts: [{ sql: 'INSERT INTO st(k,m) VALUES(?,?) ON CONFLICT(k,m) DO NOTHING', args: [a[1], String(a[2])], read: false }],
        parse: (r) => r[0].affected,
      };

    case 'SREM':
      return {
        stmts: [{ sql: 'DELETE FROM st WHERE k=? AND m=?', args: [a[1], String(a[2])], read: false }],
        parse: (r) => r[0].affected,
      };

    case 'SMEMBERS':
      return {
        stmts: [{ sql: 'SELECT m FROM st WHERE k=?', args: [a[1]], read: true }],
        parse: (r) => r[0].rows.map((row) => row[0]),
      };

    case 'SISMEMBER':
      return {
        stmts: [{ sql: 'SELECT 1 FROM st WHERE k=? AND m=?', args: [a[1], String(a[2])], read: true }],
        parse: (r) => (r[0].rows.length ? 1 : 0),
      };

    case 'SCARD':
      return {
        stmts: [{ sql: 'SELECT COUNT(*) FROM st WHERE k=?', args: [a[1]], read: true }],
        parse: (r) => Number(r[0].rows[0][0]),
      };

    case 'LPUSH':
      return {
        stmts: [
          { sql: 'INSERT INTO lst(k,seq,m) VALUES(?, COALESCE((SELECT MIN(seq) FROM lst WHERE k=?),0)-1, ?)', args: [a[1], a[1], String(a[2])], read: false },
          { sql: 'SELECT COUNT(*) FROM lst WHERE k=?', args: [a[1]], read: true },
        ],
        parse: (r) => Number(r[1].rows[0][0]),
      };

    case 'LTRIM': {
      const stop = Number(a[3]);
      return {
        stmts: [{ sql: 'DELETE FROM lst WHERE k=? AND seq NOT IN (SELECT seq FROM lst WHERE k=? ORDER BY seq ASC LIMIT ?)', args: [a[1], a[1], stop + 1], read: false }],
        parse: () => 'OK',
      };
    }

    case 'LRANGE': {
      const start = Number(a[2]), stop = Number(a[3]);
      const limit = stop < 0 ? -1 : Math.max(0, stop - start + 1);
      return {
        stmts: [{ sql: 'SELECT m FROM lst WHERE k=? ORDER BY seq ASC LIMIT ? OFFSET ?', args: [a[1], limit, Math.max(0, start)], read: true }],
        parse: (r) => r[0].rows.map((row) => row[0]),
      };
    }

    case 'SCAN': {
      let match = '*', count = 100;
      for (let i = 2; i < a.length; i++) {
        const o = String(a[i]).toUpperCase();
        if (o === 'MATCH') match = String(a[++i]);
        else if (o === 'COUNT') count = Math.max(1, Number(a[++i]) || 100);
      }
      const offset = Math.max(0, Number(a[1]) || 0);
      // glob -> LIKE: once kacis karakterlerini escape et, sonra * -> %, ? -> _
      const like = match.replace(/[\\%_]/g, (c) => '\\' + c).replace(/\*/g, '%').replace(/\?/g, '_');
      return {
        stmts: [{ sql: "SELECT k FROM kv WHERE k LIKE ? ESCAPE '\\' AND (exp IS NULL OR exp>?) ORDER BY k LIMIT ? OFFSET ?", args: [like, now, count, offset], read: true }],
        parse: (r) => {
          const keys = r[0].rows.map((row) => row[0]);
          const next = keys.length === count ? String(offset + count) : '0';
          return [next, keys];
        },
      };
    }

    default:
      throw new Error('sql-redis: unsupported command ' + op);
  }
}

/** Tum komutlari planlar, tek pipeline'da calistirir, komut basina ayristirilmis sonuc dizisi doner. */
export async function sqlRedis(commands, exec) {
  const run = exec || httpExec;
  const plans = commands.map((c) => plan(c, Date.now()));
  const flat = [];
  for (const p of plans) for (const s of p.stmts) flat.push(s);
  const results = flat.length ? await run(flat) : [];
  const out = [];
  let i = 0;
  for (const p of plans) {
    const slice = results.slice(i, i + p.stmts.length);
    i += p.stmts.length;
    out.push(p.parse(slice));
  }
  return out;
}

// ---- Turso HTTP (Hrana v2) ----

function typed(value) {
  if (value == null) return { type: 'null' };
  if (typeof value === 'number') return Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value };
  return { type: 'text', value: String(value) };
}

function cell(c) {
  if (!c || c.type === 'null') return null;
  if (c.type === 'integer') return Number(c.value);
  if (c.type === 'float') return Number(c.value);
  return c.value; // text / blob
}

let schemaDone;
async function ensureSchema(creds) {
  if (schemaDone) return schemaDone;
  schemaDone = pipeline(creds, SCHEMA.map((sql) => ({ sql, args: [] }))).then(() => true);
  return schemaDone;
}

async function pipeline(creds, stmts) {
  const requests = stmts.map((s) => ({ type: 'execute', stmt: { sql: s.sql, args: (s.args || []).map(typed) } }));
  requests.push({ type: 'close' });
  const res = await fetch(creds.url + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error('sql-http-' + res.status);
  const body = await res.json();
  const out = [];
  for (let i = 0; i < stmts.length; i++) {
    const r = body.results[i];
    if (!r || r.type === 'error') throw new Error('sql: ' + (r && r.error ? r.error.message : 'unknown'));
    const result = r.response.result;
    out.push({ rows: (result.rows || []).map((row) => row.map(cell)), affected: result.affected_row_count || 0 });
  }
  return out;
}

async function httpExec(stmts) {
  const creds = sqlCredentials();
  if (!creds) throw new Error('sql-not-configured');
  await ensureSchema(creds);
  return pipeline(creds, stmts);
}
