/**
 * Credential-free test: runs the whole function against an in-memory S3 gateway
 * that reproduces the quirks measured on the real one.
 *
 *   node test-local.mjs
 *
 * Covered: routing, CORS, origin filtering, the event -> daily -> month -> total
 * chain, idempotent rebuilds, snapshot caching, 429 retry/backoff, and graceful
 * degradation when the gateway is throttled. No network, no credentials.
 */
import { onRequest } from './functions/[[...path]].ts';
import { aggregate, getStats, recordHit } from './functions/_shared/stats.ts';

const BUCKET = 'test-bucket';
const HOST = 's3.local';
const PREFIX = 'stats';
const TOKEN = 'test-token';

// ---------------- in-memory S3 gateway ----------------

function fakeGateway() {
  const objects = new Map(); // key -> Uint8Array | { marker: true }
  const ops = { get: 0, put: 0, list: 0, del: 0, denied: 0, throttled: 0 };
  const state = { failNextGets: 0, throttleAll: false };

  const xml = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const unxml = (s) =>
    String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  // The real gateway materialises zero-byte parent "directories" on every PUT.
  function markers(key) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') + '/';
      if (!objects.has(dir)) objects.set(dir, { marker: true });
    }
  }

  function keyOf(url) {
    const path = decodeURIComponent(new URL(url).pathname);
    return path.startsWith(`/${BUCKET}/`) ? path.slice(BUCKET.length + 2) : '';
  }

  async function fetchImpl(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const u = new URL(url);
    const key = keyOf(url);

    // The gateway rejects requests whose User-Agent does not match the app name.
    if (!String(headers['Authorization'] || '').startsWith('AWS4-HMAC-SHA256 ') ||
        !String(headers['User-Agent'] || '').startsWith('FakeApp')) {
      ops.denied++;
      return new Response('denied', { status: 401 });
    }

    // LIST is exempt from the object throttle on the real gateway.
    if (method === 'GET' && key === '') {
      ops.list++;
      const prefix = u.searchParams.get('prefix') || '';
      // Quirk: a prefix that stops mid-segment matches nothing at all.
      const boundary = prefix === '' || prefix.endsWith('/');
      const keys = boundary ? [...objects.keys()].filter((k) => k.startsWith(prefix)) : [];
      const body =
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
        keys.sort().map((k) => `<Contents><Key>${xml(k)}</Key></Contents>`).join('') +
        '</ListBucketResult>';
      return new Response(body, { status: 200 });
    }

    if (state.throttleAll) {
      ops.throttled++;
      return new Response('', { status: 429 });
    }
    if (method === 'GET' && state.failNextGets > 0) {
      state.failNextGets--;
      ops.throttled++;
      return new Response('', { status: 429 });
    }

    if (method === 'PUT') {
      ops.put++;
      markers(key);
      objects.set(key, new Uint8Array(init.body || []));
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') {
      ops.del++;
      objects.delete(key);
      return new Response('', { status: 204 });
    }
    if (method === 'HEAD' || method === 'GET') {
      ops.get++;
      const hit = objects.get(key);
      if (!hit) return new Response('', { status: 404 });
      // Markers are created by the storage layer but cannot be read back.
      if (hit.marker) return new Response('', { status: 500 });
      return new Response(hit, { status: 200 });
    }
    return new Response('unsupported', { status: 400 });
  }

  return { fetch: fetchImpl, objects, ops, state };
}

function fakeBlob() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async setJSON(key, value) {
      map.set(key, JSON.stringify(value));
    },
  };
}

// ---------------- harness ----------------

const gateway = fakeGateway();
globalThis.fetch = gateway.fetch;

const env = {
  AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: BUCKET,
  S3_ENDPOINT: HOST,
  S3_REGION: 'cn-north-1',
  UA_PREFIX: 'FakeApp',
  STATS_PREFIX: PREFIX,
  STATS_SALT: 'offline-salt',
  STATS_TOKEN: TOKEN,
  STATS_ORIGINS: 'https://blog.test',
  STATS_BLOB_CACHE: 'off',
};

const BASE = 'https://stats.test';

async function call(path, { method = 'GET', body, headers = {}, ip = '203.0.113.9' } = {}) {
  return onRequest({
    request: new Request(BASE + path, { method, headers, body }),
    params: {},
    env,
    eo: { clientIp: ip },
  });
}

function hit(page, { ua = 'UA-A', ip = '198.51.100.1', origin = 'https://blog.test' } = {}) {
  return call('/api/hit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'user-agent': ua },
    body: JSON.stringify({ p: page }),
    ip,
  });
}

async function stats(page) {
  const res = await call(`/api/stats?p=${encodeURIComponent(page)}`);
  return { res, body: await res.json() };
}

let pass = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) pass = false;
  return ok;
};

console.log(`in-memory gateway   bucket=${BUCKET}   prefix=${PREFIX}\n`);

// ---- routing & views ----------------------------------------------------
check('1. health', (await call('/api/health')).status === 200);
check('2. hit -> 204', (await hit('/posts/a/')).status === 204);
await hit('/posts/a/');
await hit('/posts/a/', { ua: 'UA-B', ip: '198.51.100.2' });
await hit('/posts/b/');
check('3. foreign Origin is ignored',
  (await hit('/posts/a/', { origin: 'https://evil.test' })).status === 204);

const agg = await (await call(`/api/aggregate?token=${TOKEN}`, { method: 'POST' })).json();
check('4. aggregate counts the 4 accepted hits', agg.ok && agg.events === 4, `events=${agg.events}`);
check('5. directory markers are not counted as events', agg.events === 4 && agg.ignored === 0);

const again = await (await call(`/api/aggregate?token=${TOKEN}`, { method: 'POST' })).json();
check('6. rebuild is idempotent', again.months.length === 0 && again.events === 4);

// ---- counters -----------------------------------------------------------
const a = (await stats('/posts/a/')).body;
check('7. site totals', a.site_pv === 4 && a.site_uv === 2, `pv=${a.site_pv} uv=${a.site_uv}`);
check('8. page totals', a.page_pv === 3 && a.page_uv === 2, `pv=${a.page_pv} uv=${a.page_uv}`);
check('9. per-page separation', (await stats('/posts/b/')).body.page_pv === 1);
check('10. unknown page is zero', (await stats('/nope/')).body.page_pv === 0);
check('11. today block', a.today.site_pv === 4 && a.today.page_pv === 3, JSON.stringify(a.today));

// ---- JSONP / auth / CORS ------------------------------------------------
const js = await call('/jsonp?callback=ZzStats_1&p=/posts/a/');
const jsText = await js.text();
let parsed = null;
try {
  parsed = JSON.parse(jsText.slice('ZzStats_1('.length, -1));
} catch {}
check('12. JSONP wraps the payload', js.status === 200 && parsed?.page_pv === 3);
check('13. bad callback rejected', (await call('/jsonp?callback=alert(1)')).status === 400);
check('14. aggregate without token -> 401', (await call('/api/aggregate', { method: 'POST' })).status === 401);
check('15. wrong method -> 405', (await call('/api/hit')).status === 405);
const pre = await call('/api/stats', { method: 'OPTIONS', headers: { origin: 'https://blog.test' } });
check('16. preflight echoes an allowed origin',
  pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://blog.test');

// ---- yesterday ----------------------------------------------------------
const s3 = { accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'secret', bucket: BUCKET, host: HOST, region: 'cn-north-1', uaPrefix: 'FakeApp' };
await recordHit({
  s3, prefix: PREFIX, salt: env.STATS_SALT, tzOffset: 8,
  page: '/posts/a/', ip: '198.51.100.1', userAgent: 'UA-A',
  nowMs: Date.now() - 86_400_000,
});
await call(`/api/aggregate?token=${TOKEN}`, { method: 'POST' });
const y = (await stats('/posts/a/')).body;
check('17. yesterday is a separate bucket',
  y.yesterday.site_pv === 1 && y.site_pv === 5,
  `yesterday=${y.yesterday.site_pv} site=${y.site_pv}`);

// ---- snapshot path ------------------------------------------------------
const cfg = {
  s3, prefix: PREFIX, salt: env.STATS_SALT, tzOffset: 8,
  keepDays: 7, snapshotTtlMs: 60_000, store: fakeBlob(),
};

const cold = await getStats(cfg, '/posts/a/');
check('18. cold snapshot rebuilds once', cold.fresh === true && cold.payload.page_pv === 4);

const warm = await getStats(cfg, '/posts/a/');
check('19. warm snapshot is fresh', warm.fresh === true && warm.payload.site_pv === 5);

const missing = await getStats(cfg, '/nope/');
check('20. snapshot miss costs nothing', missing.payload.page_pv === 0 && missing.fresh === true);

// ---- resilience ---------------------------------------------------------
const before = { ...gateway.ops };
gateway.state.failNextGets = 2;
const survives = await (await call(`/api/aggregate?token=${TOKEN}`, { method: 'POST' })).json();
check('21. 429s are retried, rebuild still succeeds',
  survives.ok === true && survives.events === 5,
  `throttled=${gateway.ops.throttled - before.throttled}`);

// ---- rebuild cost -------------------------------------------------------
const opsBefore = { ...gateway.ops };
await aggregate(cfg);
const delta = {
  get: gateway.ops.get - opsBefore.get,
  put: gateway.ops.put - opsBefore.put,
  list: gateway.ops.list - opsBefore.list,
};
check('22. a no-change rebuild stays cheap',
  delta.get <= 4 && delta.put <= 1 && delta.list <= 2,
  `ops=${JSON.stringify(delta)}`);

// ---- degradation --------------------------------------------------------
// A different prefix guarantees no in-memory snapshot, so the read must hit
// the throttled gateway and still answer with zeros rather than a 500.
gateway.state.throttleAll = true;
const degraded = await onRequest({
  request: new Request(BASE + '/api/stats?p=/posts/a/'),
  params: {},
  env: { ...env, STATS_PREFIX: 'other' },
  eo: { clientIp: '203.0.113.9' },
});
gateway.state.throttleAll = false;
const degradedBody = await degraded.json();
check('23. throttled gateway degrades instead of 500',
  degraded.status === 200 && degradedBody.site_pv === 0,
  `status=${degraded.status} site_pv=${degradedBody.site_pv}`);

// ---- beacon body --------------------------------------------------------
const soft = await call('/api/hit', {
  method: 'POST',
  headers: { 'content-type': 'text/plain', origin: 'https://blog.test', 'user-agent': 'UA-C' },
  body: JSON.stringify({ p: '/posts/c/' }),
  ip: '198.51.100.3',
});
await call(`/api/aggregate?token=${TOKEN}`, { method: 'POST' });
const c = (await stats('/posts/c/')).body;
check('24. text/plain beacon body is accepted',
  soft.status === 204 && c.page_pv === 1,
  `page_pv=${c.page_pv}`);

// ---- token gate on the human pages --------------------------------------
const page = (path, { env: override = {}, headers = {} } = {}) =>
  onRequest({
    request: new Request(BASE + path, { method: 'GET', headers }),
    params: {},
    env: { ...env, ...override },
    eo: { clientIp: '203.0.113.9' },
  });

const openEnv = { STATS_ACCESS_TOKEN: '' };
const gatedEnv = { STATS_ACCESS_TOKEN: 'page-secret' };

const openRoot = await page('/', { env: openEnv });
const openRootText = await openRoot.text();
check('25. root page is public when STATS_ACCESS_TOKEN is empty',
  openRoot.status === 200 && openRootText.includes('href="/dashboard.html"'));

const gate = await page('/', { env: gatedEnv });
const gateText = await gate.text();
check('26. root asks for the token',
  gate.status === 401 && gateText.includes('name="token"') && !gateText.includes('edgeone-s3-site-statistics'));

const wrong = await page('/?token=nope', { env: gatedEnv });
const wrongText = await wrong.text();
check('27. a wrong token is refused and never echoed',
  wrong.status === 401 && wrongText.includes('令牌不正确') && !wrongText.includes('nope'));

const good = await page('/?token=page-secret', { env: gatedEnv });
const goodText = await good.text();
const cookie = good.headers.get('set-cookie') || '';
check('28. the right token renders the landing page',
  good.status === 200 && goodText.includes('href="/dashboard.html"'));
check('29. login sets an HttpOnly cookie that hides the raw token',
  /stats_access=/.test(cookie) && /HttpOnly/.test(cookie) && !cookie.includes('page-secret'));

const cookieValue = /stats_access=([^;]+)/.exec(cookie)?.[1] || '';
const dash = await page('/dashboard.html', {
  env: gatedEnv,
  headers: { cookie: `stats_access=${cookieValue}` },
});
const dashText = await dash.text();
check('30. the cookie opens the dashboard',
  dash.status === 200 && dashText.includes('站点统计'));

const dashGate = await page('/dashboard.html', { env: gatedEnv });
check('31. the dashboard is gated too', dashGate.status === 401);

const health = await page('/api/health', { env: gatedEnv });
const healthBody = await health.json();
check('32. health stays public and reports the gate',
  health.status === 200 && healthBody.pagesProtected === true);

const rootEntry = await import('./functions/index.ts');
check('33. functions/index.ts points at the same handler',
  rootEntry.onRequest === onRequest);

console.log();
console.log(pass ? 'All passed' : 'Some assertions failed');
process.exit(pass ? 0 : 1);
