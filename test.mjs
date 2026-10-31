/**
 * End-to-end verification against the real S3 gateway.
 *
 * Calls onRequest() directly so the production code path is exercised, then
 * checks the stored objects and the aggregate files. Everything is written
 * under a throwaway prefix which is cleaned before and after the run.
 *
 * Run:
 *   node test.mjs
 *
 * Credentials come from ~/.config/imgup.conf (local file, never committed,
 * never printed). Override any key with an environment variable of the same
 * name as the .env variable.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const { onRequest } = await import('./functions/[[...path]].ts');
const { readS3Config, s3ListKeys, s3Delete } = await import('./functions/_shared/s3.ts');
const { aggregate, getStats, normalizePath, encodePageKey, decodePageKey } = await import(
  './functions/_shared/stats.ts'
);

const conf = {};
try {
  for (const line of readFileSync(`${homedir()}/.config/imgup.conf`, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) conf[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
} catch {
  console.log('missing ~/.config/imgup.conf');
  process.exit(1);
}

const PREFIX = process.env.STATS_PREFIX_TEST || '_stats-test';
const TOKEN = 'test-token';

const env = {
  AWS_ACCESS_KEY_ID: conf.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: conf.AWS_SECRET_ACCESS_KEY,
  S3_BUCKET: conf.BUCKET,
  S3_ENDPOINT: conf.ENDPOINT_HOST,
  S3_REGION: conf.REGION || 'cn-north-1',
  UA_PREFIX: conf.UA || 'S3Drive',
  STATS_PREFIX: PREFIX,
  STATS_SALT: 'local-test-salt',
  STATS_TOKEN: TOKEN,
  STATS_ORIGINS: 'https://blog.test',
  STATS_BLOB_CACHE: 'off',
  STATS_BLOB_STORE: 'site-stats-test',
};

const BASE = 'https://stats.example.com';
const s3 = readS3Config(env).config;

async function call(path, { method = 'GET', body, headers = {}, ip = '203.0.113.9' } = {}) {
  const request = new Request(BASE + path, { method, headers, body });
  const res = await onRequest({ request, params: {}, env, eo: { clientIp: ip } });
  return res;
}

async function hit(page, { ua = 'UA-A', ip = '198.51.100.1', origin = 'https://blog.test' } = {}) {
  return call('/api/hit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'user-agent': ua },
    body: JSON.stringify({ p: page }),
    ip,
  });
}

async function stats(page, headers = {}) {
  const res = await call(`/api/stats?p=${encodeURIComponent(page)}`, { headers });
  return { res, body: await res.json() };
}

async function purge() {
  const keys = await s3ListKeys(s3, `${PREFIX}/`);
  for (const key of keys) {
    try {
      await s3Delete(s3, key);
    } catch {
      /* directory markers cannot always be deleted */
    }
  }
  return keys.length;
}

let pass = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) pass = false;
  return ok;
};

console.log(`bucket: ${s3.bucket}   endpoint: ${s3.host}   prefix: ${PREFIX}\n`);

const purged = await purge();
console.log(`  --    purged ${purged} leftover keys under ${PREFIX}/`);

// ---- 1..4: record views -------------------------------------------------
check('1. health', (await call('/api/health')).status === 200);

const h1 = await hit('/posts/a/');
const h2 = await hit('/posts/a/');
const h3 = await hit('/posts/a/', { ua: 'UA-B', ip: '198.51.100.2' });
const h4 = await hit('/posts/b/', { ua: 'UA-A', ip: '198.51.100.1' });
check('2. POST /api/hit -> 204', [h1, h2, h3, h4].every((r) => r.status === 204));

const bad = await hit('/posts/a/', { origin: 'https://evil.test' });
check('3. foreign Origin -> 204 but ignored', bad.status === 204);

// ---- 5..7: aggregation --------------------------------------------------
const agg1 = await (await call(`/api/aggregate?token=${TOKEN}`, { method: 'POST' })).json();
const agg2 = await (await call(`/api/aggregate?token=${TOKEN}`, { method: 'POST' })).json();
check('4. aggregate sees exactly 4 events', agg1.ok && agg1.events === 4, `events=${agg1.events}`);
check('5. aggregate is idempotent', agg2.months.length === 0 && agg2.events === 4,
  `months=${JSON.stringify(agg2.months)}`);

const daily = await (await stats('/posts/a/')).body;
check('6. site totals', daily.site_pv === 4 && daily.site_uv === 2,
  `pv=${daily.site_pv} uv=${daily.site_uv}`);
check('7. page totals', daily.page_pv === 3 && daily.page_uv === 2,
  `pv=${daily.page_pv} uv=${daily.page_uv}`);
check('8. other page', (await stats('/posts/b/')).body.page_pv === 1);
check('9. unknown page is zero', (await stats('/never/')).body.page_pv === 0);
check('10. today mirrors site today',
  daily.today.site_pv === 4 && daily.today.page_pv === 3,
  `today=${JSON.stringify(daily.today)}`);

// ---- 8: JSONP -----------------------------------------------------------
const js = await call('/jsonp?callback=ZzStats_1&p=/posts/a/');
const jsBody = await js.text();
let jsOk = false;
try {
  jsOk = JSON.parse(jsBody.slice('ZzStats_1('.length, -1)).page_pv === 3;
} catch {
  jsOk = false;
}
check('11. JSONP wraps payload', js.status === 200 && jsOk);
check('12. JSONP rejects a bad callback',
  (await call('/jsonp?callback=alert(1)')).status === 400);

// ---- 9: auth / routing --------------------------------------------------
check('13. aggregate without token -> 401',
  (await call('/api/aggregate', { method: 'POST' })).status === 401);
check('14. wrong method -> 405', (await call('/api/hit')).status === 405);
const pre = await call('/api/stats', { method: 'OPTIONS', headers: { origin: 'https://blog.test' } });
check('15. CORS preflight echoes origin',
  pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://blog.test');
const health = await (await call('/api/health')).json();
check('16. health reports no missing vars', health.missing.length === 0, JSON.stringify(health.warnings));

// ---- 10: yesterday bucket ----------------------------------------------
const { recordHit } = await import('./functions/_shared/stats.ts');
await recordHit({
  s3,
  prefix: PREFIX,
  salt: env.STATS_SALT,
  tzOffset: 8,
  page: '/posts/a/',
  ip: '198.51.100.1',
  userAgent: 'UA-A',
  nowMs: Date.now() - 86_400_000,
});
await call(`/api/aggregate?token=${TOKEN}`, { method: 'POST' }); // events are visible after a rebuild
const ystats = (await stats('/posts/a/')).body;
check('17. yesterday bucket separated',
  ystats.yesterday.site_pv === 1 && ystats.site_pv === 5,
  `yesterday.pv=${ystats.yesterday.site_pv} site.pv=${ystats.site_pv}`);

// ---- 11: snapshot path (fake Pages Blob) --------------------------------
function fakeStore() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async setJSON(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const store = fakeStore();
const cfg = {
  s3,
  prefix: PREFIX,
  salt: env.STATS_SALT,
  tzOffset: 8,
  keepDays: 7,
  snapshotTtlMs: 60_000,
  store,
};

const cold = await getStats({ ...cfg, store: fakeStore() }, '/posts/a/');
check('18. cold snapshot pays one synchronous rebuild',
  cold.fresh === true && cold.payload.page_pv === 4,
  `page_pv=${cold.payload.page_pv} fresh=${cold.fresh}`);

await aggregate(cfg);
const fromSnap = await getStats(cfg, '/posts/a/');
check('19. warm snapshot serves without reading S3 again',
  fromSnap.fresh === true && fromSnap.payload.page_pv === 4,
  `page_pv=${fromSnap.payload.page_pv} fresh=${fromSnap.fresh}`);
const zeros = await getStats(cfg, '/never/');
check('20. snapshot miss for an unseen page costs nothing',
  zeros.payload.page_pv === 0 && zeros.fresh === true);

// ---- 12: pure helpers ---------------------------------------------------
check('21. path normalisation',
  normalizePath('//a//b/?x=1#h') === '/a/b/' && normalizePath('') === '/' && normalizePath('x') === '/x');
check('22. page key round-trips unicode',
  decodePageKey(encodePageKey('/中文/路径/')) === '/中文/路径/');

// ---- 13: cleanup --------------------------------------------------------
await new Promise((r) => setTimeout(r, 800)); // let detached rebuilds settle
const removed = await purge();
const left = await s3ListKeys(s3, `${PREFIX}/`);
check('23. cleanup removed every test object', left.length === 0, `deleted=${removed} left=${left.length}`);

console.log();
console.log(pass ? 'All passed' : 'Some assertions failed');
process.exit(pass ? 0 : 1);
