// Flame V1 Cloud Configs — Vercel Function
//
//   POST   /api/config                     body: { "name", "config", "visibility": "public"|"private" }
//          -> 201 { code, display, visibility }   (ayni config tekrar yuklenirse 200 + ayni kod)
//   GET    /api/config?code=XXXX-XXXX
//          -> 200 { code, display, name, server, created, visibility, config }  |  404
//   GET    /api/config?list=public&sort=top|new&page=0
//          -> 200 { items: [{ code, display, name, server, created, modules, downloads }], page, more }
//   DELETE /api/config?code=XXXX-XXXX[&purge=1]   (header x-admin-key: ADMIN_KEY)
//          -> 200 { unpublished, purged }        public listeden kaldirir (purge=1: tamamen siler)
//
// Private config'ler listelenmez; yalnizca tam kodunu bilen ulasabilir. Public config'ler
// ayrica herkese acik listede gorunur (oyun ici "Public" sekmesi).
//
// Depolama: Upstash Redis (Vercel Marketplace).
//   cfg:CODE      tam kayit { v, name, server, created, visibility, owner, config }
//   meta:CODE     public listede gosterilen hafif ozet (config govdesi yok)
//   public:new    sorted set (skor = olusturma zamani)
//   public:top    sorted set (skor = indirme sayisi)
//
// Guvenlik katmanlari (savunma derinligi):
//   1) Katı girdi dogrulama + boyut siniri + yalnizca GET/POST/DELETE.
//   2) Yukleme icin zorunlu anahtar (UPLOAD_KEY); listeden kaldirma icin ayri ADMIN_KEY.
//   3) IP basina hiz siniri (rate limit) -> 429; public yayin icin ayrica saatlik sinir.
//   4) Kotu/basarisiz istekler "strike" toplar; esigi gecen IP otomatik BANLANIR -> 403.
//   5) Kodlar 8 hane x 30 harf ~ 6.5e11 kombinasyon; ban + limit ile kaba kuvvet imkansiz.
//   6) Indirme sayaci IP+kod basina gunde 1 kez artar (sayac sisirilemez).
//   7) Parametreli Redis komutlari (enjeksiyon yok), gizli indeksleme engeli, siki basliklar.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

// 0/1/I/L/O/U yok: okurken/yazarken karistirilmasin.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

const MAX_BYTES = (Number(process.env.MAX_CONFIG_KB) || 512) * 1024;
const TTL_SECONDS = (Number(process.env.CONFIG_TTL_DAYS) || 0) * 86400;

const UPLOADS_PER_10_MIN = Number(process.env.UPLOAD_LIMIT) || 20;
const LOOKUPS_PER_MIN = Number(process.env.LOOKUP_LIMIT) || 60;
const PUBLIC_PER_HOUR = Number(process.env.PUBLIC_LIMIT) || 5;
const ADMIN_PER_10_MIN = 60;

const PAGE_SIZE = 20;
const MAX_PAGE = 500;

// Otomatik ban: STRIKE_WINDOW icinde STRIKE_LIMIT puani gecen IP, BAN_SECONDS boyunca 403 alir.
const STRIKE_LIMIT = Number(process.env.STRIKE_LIMIT) || 20;
const STRIKE_WINDOW = Number(process.env.STRIKE_WINDOW_SEC) || 600;
const BAN_SECONDS = Number(process.env.BAN_SECONDS) || 3600;

const ROUTES = {
  GET: { bucket: 'get', max: () => LOOKUPS_PER_MIN, window: 60 },
  POST: { bucket: 'put', max: () => UPLOADS_PER_10_MIN, window: 600 },
  DELETE: { bucket: 'adm', max: () => ADMIN_PER_10_MIN, window: 600 },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const ip = clientIp(req);

  try {
    const route = ROUTES[req.method];
    if (!route) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return deny(res, ip, 2, 405, 'Method not allowed');
    }

    // 1) Hiz siniri + ban kontrolu (tek Redis turunda).
    const gate = await arrive(ip, route.bucket, route.max(), route.window);

    if (gate.banned)
      return send(res, 403, { error: 'Temporarily blocked' });

    if (gate.limited) {
      const banned = await strike(ip, 2);
      return send(res, banned ? 403 : 429, { error: banned ? 'Temporarily blocked' : 'Too many requests, slow down' });
    }

    if (req.method === 'POST') return await upload(req, res, ip);
    if (req.method === 'DELETE') return await unpublish(req, res, ip);
    if (queryParam(req, 'list')) return await listPublic(req, res, ip);
    return await lookup(req, res, ip);
  } catch (err) {
    const message = String((err && err.message) || err);
    if (message === 'storage-not-configured')
      return send(res, 500, { error: 'Storage is not configured (connect Upstash Redis to this project)' });

    console.error('[flamev1-cloud]', message);
    return send(res, 500, { error: 'Server error' });
  }
}

// ---- GET: kodla config getir ----

async function lookup(req, res, ip) {
  const code = normalize(queryParam(req, 'code'));
  if (!CODE_PATTERN.test(code))
    return deny(res, ip, 3, 400, 'Invalid code'); // bicimi bozuk kod = otomatik tarama sinyali

  const [raw, score] = await redis([
    ['GET', storageKey(code)],
    ['ZSCORE', 'public:top', code],
  ]);
  if (!raw)
    return deny(res, ip, 1, 404, 'Code not found'); // bos deneme = kaba kuvvet sinyali

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return send(res, 500, { error: 'Corrupted entry' });
  }

  const isPublic = score != null;

  // Public indirme sayaci: ayni IP ayni config'i gunde en fazla 1 kez sayar.
  if (isPublic) {
    const [first] = await redis([['SET', `dl:${ip}:${code}`, '1', 'EX', '86400', 'NX']]);
    if (first === 'OK') await redis([['ZINCRBY', 'public:top', '1', code]]);
  }

  return send(res, 200, {
    code,
    display: display(code),
    name: entry.name,
    server: entry.server || '',
    created: entry.created,
    visibility: isPublic ? 'public' : 'private',
    config: entry.config,
  });
}

// ---- GET ?list=public: herkese acik config listesi ----

async function listPublic(req, res, ip) {
  if (queryParam(req, 'list') !== 'public')
    return deny(res, ip, 3, 400, 'Unknown list');

  const sort = queryParam(req, 'sort') === 'new' ? 'new' : 'top';
  const page = Math.max(0, Math.min(MAX_PAGE, Number.parseInt(queryParam(req, 'page'), 10) || 0));
  const index = sort === 'new' ? 'public:new' : 'public:top';
  const start = page * PAGE_SIZE;
  const stop = start + PAGE_SIZE - 1;

  const [range, total] = await redis([
    sort === 'top'
      ? ['ZRANGE', index, String(start), String(stop), 'REV', 'WITHSCORES']
      : ['ZRANGE', index, String(start), String(stop), 'REV'],
    ['ZCARD', index],
  ]);

  const codes = [];
  const downloads = new Map();
  if (sort === 'top') {
    for (let i = 0; i + 1 < (range || []).length; i += 2) {
      codes.push(range[i]);
      downloads.set(range[i], Number(range[i + 1]) || 0);
    }
  } else {
    codes.push(...(range || []));
  }

  let items = [];
  if (codes.length > 0) {
    const commands = codes.map((code) => ['GET', 'meta:' + code]);
    if (sort === 'new') commands.push(['ZMSCORE', 'public:top', ...codes]);

    const results = await redis(commands);
    const scores = sort === 'new' ? results[codes.length] || [] : null;

    items = codes
      .map((code, i) => {
        let meta;
        try {
          meta = JSON.parse(results[i]);
        } catch {
          return null;
        }
        if (!meta) return null;
        return {
          code,
          display: display(code),
          name: meta.name,
          server: meta.server || '',
          created: meta.created,
          modules: meta.modules || 0,
          downloads: sort === 'top' ? downloads.get(code) || 0 : Number(scores[i]) || 0,
        };
      })
      .filter(Boolean);
  }

  return send(res, 200, { items, page, more: start + PAGE_SIZE < Number(total || 0) });
}

// ---- POST: config yukle, benzersiz kod al ----

async function upload(req, res, ip) {
  const required = process.env.UPLOAD_KEY;
  if (required && !safeEqual(header(req, 'x-flame-key'), required))
    return deny(res, ip, 5, 401, 'Unauthorized'); // yanlis/eksik anahtar = yetkisiz = agir strike

  const body = await readJson(req);
  if (!body || typeof body !== 'object')
    return deny(res, ip, 3, 400, 'Body must be JSON');

  const config = body.config;
  if (!isConfig(config))
    return deny(res, ip, 3, 400, 'Not a Flame V1 config');

  const configJson = JSON.stringify(config);
  if (Buffer.byteLength(configJson, 'utf8') > MAX_BYTES)
    return deny(res, ip, 3, 413, 'Config is too large');

  const visibility = body.visibility === 'public' ? 'public' : 'private';
  const name = cleanName(body.name);
  const server = serverName(config);
  const hash = createHash('sha256').update(visibility + '\n' + name + '\n' + configJson).digest('hex');

  // Ayni config tekrar yuklenirse ayni kodu ver (gereksiz kopya / listede tekrar olusmasin).
  const [known] = await redis([['GET', 'hash:' + hash]]);
  if (known && CODE_PATTERN.test(known)) {
    const [exists] = await redis([['EXISTS', storageKey(known)]]);
    if (Number(exists) === 1)
      return send(res, 200, { code: known, display: display(known), visibility, reused: true });
  }

  // Public yayin icin ayrica saatlik sinir (listenin spam ile dolmasini onler).
  if (visibility === 'public') {
    const pub = await arrive(ip, 'pub', PUBLIC_PER_HOUR, 3600);
    if (pub.limited) {
      const banned = await strike(ip, 2);
      return send(res, banned ? 403 : 429, { error: banned ? 'Temporarily blocked' : 'Public upload limit reached, try later' });
    }
  }

  const created = Date.now();
  const entry = JSON.stringify({ v: 2, name, server, created, visibility, owner: null, config });

  // Cakisma onleme: SET ... NX yalnizca anahtar YOKSA yazar. Kod doluysa yenisi denenir,
  // boylece iki config asla ayni kodu alamaz ve hicbir config'in ustune yazilmaz.
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = newCode();
    const set = ['SET', storageKey(code), entry, 'NX'];
    if (TTL_SECONDS > 0) set.push('EX', String(TTL_SECONDS));

    const [ok] = await redis([set]);
    if (ok !== 'OK') continue;

    const after = [ttl(['SET', 'hash:' + hash, code])];
    if (visibility === 'public') {
      const meta = JSON.stringify({ name, server, created, modules: enabledModules(config) });
      after.push(ttl(['SET', 'meta:' + code, meta]));
      after.push(['ZADD', 'public:new', String(created), code]);
      after.push(['ZADD', 'public:top', '0', code]);
    }
    await redis(after);

    return send(res, 201, { code, display: display(code), visibility });
  }

  return send(res, 503, { error: 'Could not allocate a code, try again' });
}

// ---- DELETE: (yalnizca sahip) public listeden kaldir / tamamen sil ----

async function unpublish(req, res, ip) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey)
    return deny(res, ip, 2, 404, 'Not found'); // anahtar ayarlanmadiysa bu islem kapali

  if (!safeEqual(header(req, 'x-admin-key'), adminKey))
    return deny(res, ip, 5, 401, 'Unauthorized');

  const code = normalize(queryParam(req, 'code'));
  if (!CODE_PATTERN.test(code))
    return deny(res, ip, 3, 400, 'Invalid code');

  const purge = queryParam(req, 'purge') === '1';
  const commands = [
    ['ZREM', 'public:new', code],
    ['ZREM', 'public:top', code],
    ['DEL', 'meta:' + code],
  ];
  if (purge) commands.push(['DEL', storageKey(code)]);

  const results = await redis(commands);
  return send(res, 200, {
    code,
    unpublished: Number(results[1]) > 0 || Number(results[0]) > 0,
    purged: purge ? Number(results[3]) > 0 : false,
  });
}

// ---- Guvenlik: hiz siniri, strike, otomatik ban ----

/** Tek Redis turunda: IP banli mi + hiz siniri sayaci. */
async function arrive(ip, bucket, max, windowSeconds) {
  const rlKey = `rl:${bucket}:${ip}`;
  const commands = [['GET', 'ban:' + ip]];

  if (max > 0) {
    commands.push(['SET', rlKey, '0', 'EX', String(windowSeconds), 'NX']);
    commands.push(['INCR', rlKey]);
  }

  const results = await redis(commands);
  const banned = results[0] != null;
  const count = max > 0 ? Number(results[2]) : 0;

  return { banned, limited: max > 0 && count > max };
}

/** Kotu istegi reddeder: puan ekler, bu istekle ban esigi asilirsa 403, yoksa asil kodu doner. */
async function deny(res, ip, weight, status, message) {
  const banned = await strike(ip, weight);
  return send(res, banned ? 403 : status, { error: banned ? 'Temporarily blocked' : message });
}

/** IP'ye puan ekler; esik asilirsa IP'yi banlar. Banlandiysa true doner. */
async function strike(ip, weight) {
  if (!ip || ip === 'unknown' || STRIKE_LIMIT <= 0) return false;

  const key = 'strike:' + ip;
  const [, count] = await redis([
    ['SET', key, '0', 'EX', String(STRIKE_WINDOW), 'NX'],
    ['INCRBY', key, String(Math.max(1, weight))],
  ]);

  if (Number(count) >= STRIKE_LIMIT) {
    await redis([['SET', 'ban:' + ip, String(Date.now()), 'EX', String(BAN_SECONDS)]]);
    return true;
  }

  return false;
}

// ---- Yardimcilar ----

function storageKey(code) {
  return 'cfg:' + code;
}

function ttl(command) {
  if (TTL_SECONDS > 0) command.push('EX', String(TTL_SECONDS));
  return command;
}

function newCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

function normalize(value) {
  return [...String(value || '').toUpperCase()].filter((c) => ALPHABET.includes(c)).join('');
}

function display(code) {
  return code.slice(0, 4) + '-' + code.slice(4);
}

function cleanName(value) {
  const name = String(value || '').replace(/[^a-zA-Z0-9 _.-]/g, '').trim().slice(0, 32);
  return name || 'config';
}

function serverName(config) {
  const server = config && config.server;
  if (!server || typeof server !== 'object') return '';

  const name = typeof server.name === 'string' ? server.name : '';
  if (name.toLowerCase() === 'singleplayer') return 'Singleplayer';

  return (name || (typeof server.ip === 'string' ? server.ip : '')).replace(/[^\w .:-]/g, '').slice(0, 64);
}

function enabledModules(config) {
  let count = 0;
  for (const [key, value] of Object.entries(config))
    if (key !== 'server' && value && typeof value === 'object' && value.enabled === true) count++;
  return count;
}

/** Flame V1 config'i mi: en az bir { enabled: boolean } modul objesi olmali. */
function isConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;

  const keys = Object.keys(config);
  if (keys.length === 0 || keys.length > 500) return false;

  let modules = 0;
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > 64) return false;
    const value = config[key];
    if (key !== 'server' && value && typeof value === 'object' && !Array.isArray(value) && typeof value.enabled === 'boolean')
      modules++;
  }

  return modules > 0;
}

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value || '';
}

function queryParam(req, name) {
  if (req.query && req.query[name] !== undefined) {
    const value = req.query[name];
    return String(Array.isArray(value) ? value[0] : value);
  }

  try {
    return new URL(req.url, 'http://localhost').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

function clientIp(req) {
  const forwarded = header(req, 'x-forwarded-for').split(',')[0].trim();
  return forwarded || header(req, 'x-real-ip') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req) {
  let body;
  try {
    body = req.body; // Vercel bunu hazir verebilir
  } catch {
    return null;
  }

  if (body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES + 64 * 1024) return null; // asiri govde: erken kes
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }

  if (Buffer.isBuffer(body)) body = body.toString('utf8');

  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES + 64 * 1024) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  return body;
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

// ---- Upstash Redis (REST) ----
// Vercel Marketplace'ten baglaninca ortam degiskenleri otomatik eklenir. Isimler
// (KV_REST_API_URL / UPSTASH_REDIS_REST_URL / ozel onekli) hangisi olursa bulunur.

let credentialsCache;

function credentials() {
  if (credentialsCache !== undefined) return credentialsCache;

  const env = process.env;
  const pairs = [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ];

  for (const [url, token] of pairs)
    if (env[url] && env[token]) return (credentialsCache = { url: env[url], token: env[token] });

  for (const name of Object.keys(env)) {
    let tokenName = null;
    if (name.endsWith('_REST_API_URL')) tokenName = name.replace(/_REST_API_URL$/, '_REST_API_TOKEN');
    else if (name.endsWith('_REDIS_REST_URL')) tokenName = name.replace(/_REDIS_REST_URL$/, '_REDIS_REST_TOKEN');

    if (tokenName && env[tokenName]) return (credentialsCache = { url: env[name], token: env[tokenName] });
  }

  return (credentialsCache = null);
}

async function redis(commands) {
  const creds = credentials();
  if (!creds) throw new Error('storage-not-configured');

  const response = await fetch(creds.url.replace(/\/+$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });

  if (!response.ok) throw new Error('storage-http-' + response.status);

  const results = await response.json();
  return results.map((item) => {
    if (item && item.error) throw new Error('storage: ' + item.error);
    return item ? item.result : null;
  });
}
