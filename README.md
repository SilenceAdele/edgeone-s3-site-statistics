# edgeone-s3-site-statistics

Self-hosted page-view / visitor counters for a static blog — **EdgeOne Pages Edge Function** edition, backed by an S3-compatible bucket.

Replaces public counters (busuanzi and friends) with a service you own:

```
POST /api/hit?p=/posts/foo/     record a view         -> 204
GET  /api/stats?p=/posts/foo/   counters as JSON      -> 200
GET  /jsonp?callback=X&p=/...   counters as JSONP     -> 200
POST /api/aggregate?token=...   force a rebuild       -> 200
GET  /?token=                   landing page          -> 200 (401 without a valid token)
GET  /dashboard.html?token=     self-check page       -> 200 (401 without a valid token)
GET  /api/health                configuration check   -> 200
```

The JSON shape matches what `vitepress-theme-teek`'s `docAnalysis` consumes
(`site_pv`, `site_uv`, `page_pv`, `page_uv`, `today`, `yesterday`), so the blog
needs no theme patch — just a `requestFn`.

---

## Why this exists

This service provides site statistics in the spirit of `busuanzi` — page views
and unique visitors for the whole site and for each page, plus today and
yesterday — as an EdgeOne Pages Edge Function that stores its data in your own
S3-compatible bucket. The API and JSON shape match what `busuanzi` clients
expect, so a static blog points at it with nothing more than a `requestFn`.

## How it works

```
browser  --POST /api/hit-->  function  --PUT zero-byte object-->  S3
browser  --GET /api/stats--> function  --read snapshot-->  Pages Blob (60 s)
                                    \-- miss --> rebuild from S3
```

Every page view writes **one immutable object whose key carries all the
information**; nothing is ever incremented in place:

```
stats/e/2026-10-31/L3Bvc3RzL2Ev/1793435681297-59eb743472000a64-8d9f   (0 bytes)
        \_ day     \_ base64url(path)  \_ ms  \_ visitor hash  \_ rand
```

Aggregates are then **recomputed from those inputs**:

```
stats/e/<date>/...                  raw events (deleted after STATS_KEEP_DAYS)
stats/agg/daily/<date>.json         pv/uv for the site and each page, one day
stats/agg/month/<YYYY-MM>.json      sum of that month's daily files
stats/agg/total.json                sum of all monthly files
```

Why events instead of `SET pv = pv + 1`? Because this storage offers no atomic
increment: the gateway ignores `If-None-Match: *` and returns UUID ETags, so two
concurrent function instances would read-modify-write and lose counts. An
immutable event log plus idempotent recomputation is safe under any level of
concurrency — running the rebuild twice, or from ten isolates at once, converges
on the same numbers.

Rebuilds are lazy: a stats read serves the cached snapshot immediately and, if it
is older than `STATS_SNAPSHOT_TTL_MS`, schedules a rebuild in the background via
`waitUntil`. No cron job is required. `POST /api/aggregate` exists for forcing a
rebuild by hand.

## What "UV" means here

A visitor is an HMAC-SHA256 of `IP + User-Agent` keyed by `STATS_SALT` **and the
day**, truncated to 16 hex chars. The salt rotates daily, so:

- no raw IP address and no long-lived identifier is ever stored;
- a visitor cannot be followed across days;
- therefore **UV is the number of unique visitor-days**, and total UV is the sum
  of daily UV, not the number of distinct people ever.

That is the same trade-off busuanzi makes without saying so, and it is the only
definition that stays privacy-preserving without cookies.

## API

| Route | Method | Notes |
|---|---|---|
| `/api/hit` | POST | Body `{"p":"/path/"}` (JSON or form), or `?p=`. Always `204` — a counter must never break the page it is embedded in. Foreign `Origin`s are dropped silently. |
| `/api/stats` | GET | `?p=/path/`. Returns the counters plus `today` / `yesterday` and `servedAt`. `cache-control: no-store`. |
| `/jsonp` | GET | `?callback=<identifier>&p=`. The callback must match `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$`; anything else is `400`. No callback name is hardcoded, so any prefix works. |
| `/api/aggregate` | POST | Requires `?token=` or `x-stats-token`. Returns the number of events, days and months it processed. |
| `/` | GET | Landing page. Gated by `STATS_ACCESS_TOKEN` when it is set; accepts `?token=` or the `x-stats-token` header, and stores a 12-hour `HttpOnly` cookie on success. |
| `/dashboard.html` | GET | Self-check page that calls `/api/stats`. Same gate and cookie as `/`. |
| `/api/health` | GET | Missing variables, active warnings, prefix, bucket, snapshot store. Stays public and never echoes secrets. |

Response body of `/api/stats`:

```json
{
  "site_pv": 1234, "site_uv": 567,
  "page_pv": 89, "page_uv": 42,
  "today":     { "site_pv": 12, "site_uv": 8, "page_pv": 3, "page_uv": 2 },
  "yesterday": { "site_pv": 30, "site_uv": 21, "page_pv": 7, "page_uv": 5 },
  "updatedAt": 1793435681868,
  "servedAt": 1793435740000
}
```

`/` renders the landing page and `/dashboard.html` is a one-page self-check UI
that calls `/api/stats` — useful right after deployment, before the blog is wired
up. Both pages are served by the function from `functions/_shared/pages.ts`
rather than `public/`: EdgeOne serves static files before functions, so a static
page could never be token-gated. `functions/index.ts` re-exports the handler
because EdgeOne maps only `index.ts` to the root path; a catch-all does not cover
`/`. If `STATS_ACCESS_TOKEN` is set, both pages answer `401` with a token prompt
until it checks out.

## Deployment

1. Create a project on [EdgeOne Pages](https://console.cloud.tencent.com/edgeone/pages) and upload this repository.
2. **Project → Settings → Environment Variables** — configure the table below.
3. Point a domain at it, e.g. `stats.example.com`.
4. Open `https://stats.example.com/api/health` (expect `"ok": true` and
   `"s3Ready": true`), then `/` — it asks for `STATS_ACCESS_TOKEN` when that
   variable is set — and open `/dashboard.html` from there.

`/api/health` issues one LIST against the bucket. If `s3Ready` is `false`, the
credentials, bucket, endpoint or `UA_PREFIX` are wrong — a common mistake is
typing the variable name `UA_PREFIX` into its own value, which the gateway
answers with `401` and which otherwise only shows up as "every counter is zero".
Changing environment variables in the console takes effect on the next
deployment, not immediately.

### Environment variables

All credentials come from environment variables only. No secret is hardcoded.

| Variable | Required | Notes |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | yes | Type **Secret**. Prefer a key scoped to this prefix only. |
| `AWS_SECRET_ACCESS_KEY` | yes | Type **Secret**. |
| `S3_BUCKET` | yes | Bucket name. |
| `S3_ENDPOINT` | yes | Hostname only, no `https://`. |
| `S3_REGION` | no | Default `cn-north-1`. |
| `UA_PREFIX` | no | Default `S3Drive`. Must match the application the key is bound to. |
| `STATS_PREFIX` | no | Key prefix in the bucket. Default `stats`. Fixed server-side; never taken from a request. |
| `STATS_SALT` | **strongly recommended** | HMAC key for visitor hashes. 32+ random characters. |
| `STATS_ORIGINS` | **strongly recommended** | Comma-separated origins allowed to POST hits. Empty = anyone may. |
| `STATS_TOKEN` | recommended | Protects `POST /api/aggregate`. Empty = that route is disabled (`403`). |
| `STATS_ACCESS_TOKEN` | recommended | Protects the human pages `/` and `/dashboard.html`. Empty = both pages stay public. Independent from `STATS_TOKEN`; set both (the same value is fine) when you want everything locked. |
| `STATS_TZ_OFFSET` | no | Hours offset deciding the calendar day. Default `8` (Asia/Shanghai). |
| `STATS_KEEP_DAYS` | no | Raw events are deleted this many days after their day ends. Default `7`. Daily/month/total files are never deleted. |
| `STATS_SNAPSHOT_TTL_MS` | no | How long a snapshot is served before a background rebuild. Default `60000`. |
| `STATS_BLOB_CACHE` | no | `on` (default) / `off`. Snapshot cache on Pages Blob. |
| `STATS_BLOB_STORE` | no | Blob store name. Default `site-stats`. |

`STATS_BLOB_STORE` **must not be `s3-cache`**: that namespace belongs to
`edgeone-s3-proxy`, whose FIFO eviction deletes any key missing from its own
`__index__` manifest. The service warns about this in `/api/health`.

## Wiring the blog (vitepress-theme-teek)

### 1. Send the hit

In `docs/.vitepress/theme/index.ts`:

```ts
const STATS = 'https://stats.example.com';

function track(path: string) {
  if (typeof document === 'undefined' || document.visibilityState === 'hidden') return;
  const body = JSON.stringify({ p: path });
  if (navigator.sendBeacon) {
    // text/plain keeps the beacon a CORS-simple request: no preflight per view.
    navigator.sendBeacon(`${STATS}/api/hit`, new Blob([body], { type: 'text/plain' }));
  } else {
    fetch(`${STATS}/api/hit`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      keepalive: true,
    }).catch(() => {});
  }
}

export default defineConfig({
  extends: Teek,
  enhanceApp({ router }) {
    if (!import.meta.env.PROD) return;
    const previous = router.onAfterRouteChange;
    router.onAfterRouteChange = (to, ...rest) => {
      previous?.(to, ...rest);
      track(to);
    };
    track(window.location.pathname); // initial load is not a navigation
  },
});
```

`sendBeacon` keeps the request alive when the tab closes, and the `204` response
means the browser never surfaces an error. Failing to record a hit must never
break the page, so the client ignores failures entirely.

### 2. Read the counters

```ts
docAnalysis: {
  createTime: '2025-11-05',
  statistics: {
    provider: 'busuanzi', // unused once requestFn is set; kept for typing
    url: 'https://stats.example.com/api/stats',
    requestFn: async (url) => {
      const p = window.location.pathname;
      const res = await fetch(`${url}?p=${encodeURIComponent(p)}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`stats ${res.status}`);
      const d = await res.json();
      // teek maps any falsy value to its 9999 placeholder, so a brand-new page
      // would display 9999 instead of 0. Clamp to 1 while the first hit lands.
      const atLeastOne = (n: number) => Math.max(1, Number(n) || 0);
      return {
        site_pv: atLeastOne(d.site_pv),
        site_uv: atLeastOne(d.site_uv),
        page_pv: atLeastOne(d.page_pv),
        page_uv: atLeastOne(d.page_uv),
        today: d.today,
        yesterday: d.yesterday,
      };
    },
    tryRequest: true,
    tryCount: 3,
    tryIterationTime: 2000,
  },
  wordCount: true,
  readingTime: true,
},
```

If you prefer a `<script>` tag instead of `fetch`, point it at the JSONP route —
the callback name is yours to choose and is validated server-side.

## Behaviour worth knowing

- **New hits appear after a rebuild.** The snapshot is up to `STATS_SNAPSHOT_TTL_MS`
  old; the first request after that window still gets the old numbers, then the
  rebuild runs in the background. With `STATS_BLOB_CACHE=off` each isolate keeps
  its own snapshot in memory for the TTL, so requests still do not hit S3 one for
  one.
- **A first-ever request is slow once.** With Blob enabled and no snapshot yet,
  the read pays one synchronous rebuild, then stores the snapshot.
- **Paths are normalised** (query/hash stripped, double slashes collapsed,
  control characters removed, capped at 400 chars) and stored base64url-encoded
  as the storage key, so a hostile path cannot escape the prefix.
- **The origin allowlist is anti-noise, not authentication.** Anyone can replay a
  request with a forged `Origin`. If you need real protection, put the endpoint
  behind a WAF rate limit or a signed token; the design goal here is honest
  counting for a personal blog, not bot resistance.

## Storage quirks discovered on this gateway

Measured, not assumed:

1. **LIST honours only directory prefixes.** `prefix=stats/agg/daily/2026-10-`
   returns zero keys even though the object exists; `prefix=stats/agg/daily/`
   returns it. Monthly rebuilds therefore list the daily directory once and
   filter by month in code.
2. **Directory markers exist and are unreadable.** Every nested PUT creates
   zero-byte keys such as `stats/agg/month/`; `GET` on one returns `500`, not
   `404`. They are skipped by suffix `/` and by the `.json` filter.
3. **No conditional writes.** `If-None-Match: *` is ignored and ETags are UUIDs —
   the reason for the event-log design.
4. **EdgeOne does not CDN-cache function responses.** Static assets return
   `EO-Cache-Status: Cache Hit`; function routes return no such header and run on
   every request. Hence the Pages Blob snapshot.
5. **`setJSON` has no compare-and-swap.** Concurrent snapshot writes can lose an
   update; the next rebuild overwrites it with a full recomputation, so the loss
   is bounded to one TTL.
6. **Sustained object traffic is throttled.** After a few hundred GET/PUT calls
   in a short window the gateway answers `429` with an empty body, while `HEAD`
   and `LIST` keep working. The client retries `429` with exponential backoff,
   and `/api/stats` degrades to the last known snapshot instead of failing. Keep
   the Blob snapshot enabled in production: it is the difference between roughly
   one S3 round trip per minute and one per visitor.

## Local verification

```bash
# No credentials, no network: an in-memory gateway that reproduces the quirks
# below (markers, boundary-only LIST prefixes, 429 bursts).
node test-local.mjs

# End-to-end against the real gateway: writes events under _stats-test/,
# checks aggregates, JSONP, auth, CORS, then deletes everything it created.
node test.mjs
```

The offline suite covers routing, CORS, origin filtering, the whole
event → daily → month → total chain, idempotent rebuilds, snapshot caching,
retry after `429`, the token gate on the two pages, and degradation to a stale
snapshot when the gateway refuses everything. Expected output ends with:

```
  PASS  21. 429s are retried, rebuild still succeeds  throttled=2
  PASS  22. a no-change rebuild stays cheap  ops={"get":4,"put":1,"list":1}
  PASS  23. throttled gateway degrades instead of 500  status=200 site_pv=0
  PASS  26. root asks for the token
  PASS  30. the cookie opens the dashboard
  PASS  33. functions/index.ts points at the same handler

All passed
```

`test.mjs` talks to the real bucket. Credentials are read from
`~/.config/imgup.conf` (local file, never committed, never printed):

```
  --    purged 0 leftover keys under _stats-test/
  PASS  1. health
  PASS  2. POST /api/hit -> 204
  ...
  PASS 17. yesterday bucket separated  yesterday.pv=1 site.pv=5
  PASS 23. cleanup removed every test object  deleted=19 left=0

All passed
```

Both call `onRequest()` directly, so they exercise the real signing, routing and
aggregation code rather than a re-implementation that could drift. Because the
bucket provider throttles sustained object traffic, `test.mjs` should be run
occasionally rather than in a loop; the offline suite is the one to run on every
change.

## Cost and limits

A view is one zero-byte PUT and a few stored bytes in the day's index. A rebuild
is one LIST plus a handful of small GETs, and it runs at most once per snapshot
TTL — and only after someone reads the counters. Cost therefore scales with
traffic, not with wall-clock time: an idle blog costs nothing.

## Security notes

- **Never** commit AccessKeys. `.env.example` lists variable names only.
- Create a **dedicated, read/write key limited to the stats prefix** rather than
  reusing a full-control key.
- Rotating `STATS_SALT` changes the visitor hashes: UV for the current day
  restarts from zero, historical numbers stay as they were.
- `STATS_ACCESS_TOKEN` only hides the two human pages; `/api/stats` stays public
  because the blog reads it in every visitor's browser. Changing the token
  invalidates the login cookie.
- Raw IPs are only used in memory to compute the daily hash; they are never
  written to storage or logged.

## License

MIT
