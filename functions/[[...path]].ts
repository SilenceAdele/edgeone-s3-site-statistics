/**
 * edgeone-s3-site-statistics - self-hosted page-view / visitor counter
 * (EdgeOne Pages Edge Function).
 *
 * A static blog cannot count its own visitors, and public counters such as
 * busuanzi are unreliable. This service records one immutable object per page
 * view in an S3-compatible bucket and answers aggregate queries:
 *
 *   POST /api/hit?p=/posts/foo/      record a view          -> 204
 *   GET  /api/stats?p=/posts/foo/    counters as JSON       -> 200
 *   GET  /jsonp?callback=X&p=/...    counters as JSONP      -> 200
 *   POST /api/aggregate?token=...    force a rebuild         -> 200
 *   GET  /api/health                 config sanity check    -> 200
 *
 * The response shape matches what vitepress-theme-teek's `docAnalysis` expects
 * (`site_pv`, `site_uv`, `page_pv`, `page_uv`, `today`, `yesterday`), so the
 * blog can consume it through `statistics.requestFn` with no theme changes.
 *
 * All credentials come from environment variables. Nothing is hardcoded.
 */

import { getBlobStore } from './_shared/blob.ts';
import { readS3Config, s3Request, type S3Config } from './_shared/s3.ts';
import { aggregate, getStats, recordHit, type StatsConfig } from './_shared/stats.ts';

/** EdgeOne Edge Function context (hand-written to avoid a type dependency). */
interface FnContext {
  request: Request;
  params: Record<string, string | string[]>;
  env: Record<string, string | undefined>;
  waitUntil?: (p: Promise<unknown>) => void;
  eo?: { geo?: unknown; clientIp?: string };
}

const SERVICE = 'edgeone-s3-site-statistics';
const CALLBACK_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const PREFIX_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// Per-isolate throttle for background rebuilds: without it, a Blob-less
// deployment would recompute aggregates on every single request.
let lastAggregateAt = 0;

interface ServiceConfig extends StatsConfig {
  origins: string[];
  token: string;
  missing: string[];
  warnings: string[];
  blobEnabled: boolean;
  blobStoreName: string;
}

export const onRequest = async (ctx: FnContext): Promise<Response> => {
  try {
    return await handle(ctx);
  } catch (e) {
    return json({ error: `stats error: ${(e as Error).message || String(e)}` }, 500);
  }
};

async function handle(ctx: FnContext): Promise<Response> {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const cfg = await readConfig(env);
  const cors = corsHeaders(cfg, request);

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (path === '/' || path === '/api/health') {
    return json(await healthPayload(cfg, url), 200, { ...cors, 'cache-control': 'no-store' });
  }

  if (cfg.missing.length) {
    return json(
      {
        error: `Missing environment variables: ${cfg.missing.join(', ')}`,
        hint:
          'EdgeOne Pages console -> Project -> Settings -> Environment Variables. ' +
          'See .env.example in the repository.',
      },
      500,
      cors,
    );
  }

  if (path === '/api/hit') {
    if (method !== 'POST') return methodNotAllowed(cors);
    return handleHit(ctx, cfg, url, cors);
  }

  if (path === '/api/stats') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(cors);
    return handleStats(ctx, cfg, url, cors);
  }

  if (path === '/jsonp' || path === '/api/jsonp') {
    if (method !== 'GET') return methodNotAllowed(cors);
    return handleJsonp(ctx, cfg, url, cors);
  }

  if (path === '/api/aggregate') {
    if (method !== 'POST') return methodNotAllowed(cors);
    return handleAggregate(ctx, cfg, url, cors);
  }

  return json({ error: 'Not found' }, 404, cors);
}

// ================= handlers =================

async function handleHit(
  ctx: FnContext,
  cfg: ServiceConfig,
  url: URL,
  cors: Record<string, string>,
): Promise<Response> {
  // Always 204: a counter must never break the page it is embedded in.
  const ok = new Response(null, { status: 204, headers: cors });

  if (!originAllowed(cfg, ctx.request)) return ok;

  const body = await readLooseBody(ctx.request);
  const page =
    body.p ||
    body.path ||
    url.searchParams.get('p') ||
    url.searchParams.get('path') ||
    refererPath(ctx.request) ||
    '/';

  const job = recordHit({
    s3: cfg.s3,
    prefix: cfg.prefix,
    salt: cfg.salt,
    tzOffset: cfg.tzOffset,
    page: String(page),
    ip: clientIp(ctx),
    userAgent: ctx.request.headers.get('user-agent') || '',
  }).catch(() => {});

  if (ctx.waitUntil) ctx.waitUntil(job);
  else await job;

  return ok;
}

async function handleStats(
  ctx: FnContext,
  cfg: ServiceConfig,
  url: URL,
  cors: Record<string, string>,
): Promise<Response> {
  const page = url.searchParams.get('p') || url.searchParams.get('path') || '/';
  const { payload, fresh } = await getStats(cfg, page);

  if (!fresh) scheduleAggregate(ctx, cfg);

  const headers = { ...cors, 'cache-control': 'no-store' };
  if (ctx.request.method.toUpperCase() === 'HEAD') return new Response(null, { status: 200, headers });
  return json(payload, 200, headers);
}

async function handleJsonp(
  ctx: FnContext,
  cfg: ServiceConfig,
  url: URL,
  cors: Record<string, string>,
): Promise<Response> {
  const callback = url.searchParams.get('callback') || url.searchParams.get('jsonpCallback') || '';
  if (!CALLBACK_RE.test(callback)) {
    return text('Invalid callback: expected an identifier such as ZzStats_1', 400, cors);
  }

  const page = url.searchParams.get('p') || url.searchParams.get('path') || '/';
  const { payload, fresh } = await getStats(cfg, page);
  if (!fresh) scheduleAggregate(ctx, cfg);

  return new Response(`${callback}(${JSON.stringify(payload)})`, {
    status: 200,
    headers: {
      ...cors,
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function handleAggregate(
  ctx: FnContext,
  cfg: ServiceConfig,
  url: URL,
  cors: Record<string, string>,
): Promise<Response> {
  if (!cfg.token) {
    return json(
      { error: 'Aggregate endpoint disabled: STATS_TOKEN is not configured' },
      403,
      cors,
    );
  }
  const provided = url.searchParams.get('token') || ctx.request.headers.get('x-stats-token') || '';
  if (!safeEqual(provided, cfg.token)) return json({ error: 'Unauthorized' }, 401, cors);

  const result = await aggregate(cfg);
  lastAggregateAt = Date.now();
  return json({ ok: true, ...result }, 200, { ...cors, 'cache-control': 'no-store' });
}

function scheduleAggregate(ctx: FnContext, cfg: ServiceConfig): void {
  const now = Date.now();
  if (now - lastAggregateAt < cfg.snapshotTtlMs) return;
  lastAggregateAt = now;
  const job = aggregate(cfg).catch(() => {});
  if (ctx.waitUntil) ctx.waitUntil(job);
}

// ================= config =================

async function readConfig(env: Record<string, string | undefined>): Promise<ServiceConfig> {
  const { config, missing } = readS3Config(env);
  const warnings: string[] = [];

  let prefix = (env.STATS_PREFIX || 'stats').replace(/^\/+|\/+$/g, '');
  if (!PREFIX_RE.test(prefix) || prefix.includes('..')) {
    warnings.push(`STATS_PREFIX "${prefix}" is invalid; falling back to "stats"`);
    prefix = 'stats';
  }

  const rawSalt = env.STATS_SALT || '';
  if (!rawSalt) warnings.push('STATS_SALT is not set: visitor hashes use a fixed fallback salt');

  let tzOffset = Number(env.STATS_TZ_OFFSET ?? 8);
  if (!Number.isFinite(tzOffset) || tzOffset < -12 || tzOffset > 14) tzOffset = 8;

  let keepDays = Number(env.STATS_KEEP_DAYS || 7);
  if (!Number.isFinite(keepDays) || keepDays < 1) keepDays = 7;
  keepDays = Math.min(Math.floor(keepDays), 90);

  let snapshotTtlMs = Number(env.STATS_SNAPSHOT_TTL_MS || 60_000);
  if (!Number.isFinite(snapshotTtlMs)) snapshotTtlMs = 60_000;
  snapshotTtlMs = Math.min(Math.max(snapshotTtlMs, 5_000), 3_600_000);

  const origins = (env.STATS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!origins.length) {
    warnings.push('STATS_ORIGINS is empty: any site may POST hits to this endpoint');
  }

  const blobEnabled = (env.STATS_BLOB_CACHE || 'on').toLowerCase() !== 'off';
  const blobStoreName = env.STATS_BLOB_STORE || 'site-stats';
  if (blobStoreName === 's3-cache') {
    warnings.push(
      'STATS_BLOB_STORE must not be "s3-cache": that store belongs to edgeone-s3-proxy and evicts foreign keys',
    );
  }

  const store = blobEnabled ? await getBlobStore(blobStoreName) : null;

  return {
    s3: (config as S3Config) || emptyS3(),
    missing,
    prefix,
    salt: rawSalt || `${prefix}:no-salt`,
    tzOffset,
    keepDays,
    snapshotTtlMs,
    store,
    origins,
    token: env.STATS_TOKEN || '',
    blobEnabled,
    blobStoreName,
    warnings,
  };
}

/** Placeholder so `cfg` is always shaped like a config; `missing` blocks use. */
function emptyS3(): S3Config {
  return {
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    host: '',
    region: 'cn-north-1',
    uaPrefix: 'S3Drive',
  };
}

async function healthPayload(cfg: ServiceConfig, url: URL) {
  const s3 = await probeS3(cfg);
  return {
    ok: cfg.missing.length === 0 && s3.s3Ready,
    service: SERVICE,
    prefix: cfg.prefix,
    bucket: cfg.s3.bucket || null,
    endpoint: cfg.s3.host || null,
    uaPrefix: cfg.s3.uaPrefix,
    ...s3,
    tzOffset: cfg.tzOffset,
    keepDays: cfg.keepDays,
    snapshotTtlMs: cfg.snapshotTtlMs,
    snapshotStore: cfg.blobEnabled ? cfg.blobStoreName : null,
    snapshotCacheReady: !!cfg.store,
    origins: cfg.origins,
    aggregateEndpoint: !!cfg.token,
    missing: cfg.missing,
    warnings: cfg.warnings,
    dashboard: new URL('/dashboard.html', url).toString(),
    time: new Date().toISOString(),
  };
}

/**
 * One cheap LIST proves the whole chain: key, secret, bucket, endpoint and the
 * UA prefix the gateway gates on. Without it a wrong UA_PREFIX is invisible
 * and every counter just reads zero.
 */
async function probeS3(cfg: ServiceConfig): Promise<{ s3Ready: boolean; s3Error?: string }> {
  if (cfg.missing.length) {
    return { s3Ready: false, s3Error: `missing: ${cfg.missing.join(', ')}` };
  }
  try {
    const res = await s3Request(cfg.s3, {
      method: 'GET',
      key: '',
      query: { 'list-type': '2', 'max-keys': '1', prefix: `${cfg.prefix}/` },
    });
    if (res.ok) return { s3Ready: true };
    const hint =
      res.status === 401 || res.status === 403
        ? ' (UA_PREFIX must be the app name the AccessKey is bound to)'
        : '';
    return { s3Ready: false, s3Error: `S3 ${res.status}${hint}` };
  } catch (e) {
    return { s3Ready: false, s3Error: (e as Error).message || String(e) };
  }
}

// ================= helpers =================

function corsHeaders(cfg: ServiceConfig, request: Request): Record<string, string> {
  const base: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-stats-token',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
  if (!cfg.origins.length) return { ...base, 'access-control-allow-origin': '*' };
  if (origin && cfg.origins.includes(origin)) {
    return { ...base, 'access-control-allow-origin': origin };
  }
  // No allow-origin header: a cross-site reader gets nothing usable.
  return base;
}

function originAllowed(cfg: ServiceConfig, request: Request): boolean {
  if (!cfg.origins.length) return true;
  const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
  if (origin) return cfg.origins.includes(origin);
  const ref = request.headers.get('referer') || '';
  try {
    return cfg.origins.includes(new URL(ref).origin.replace(/\/+$/, ''));
  } catch {
    return false;
  }
}

function clientIp(ctx: FnContext): string {
  const eoIp = ctx.eo?.clientIp;
  if (eoIp) return eoIp;
  const headers = ctx.request.headers;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  // Edge nodes name this differently depending on the platform flavour; if none
  // of these exist, every visitor sharing a User-Agent counts as one.
  return (
    headers.get('eo-connecting-ip') ||
    headers.get('true-client-ip') ||
    headers.get('x-client-ip') ||
    headers.get('x-real-ip') ||
    headers.get('cf-connecting-ip') ||
    '0.0.0.0'
  );
}

function refererPath(request: Request): string {
  const ref = request.headers.get('referer');
  if (!ref) return '';
  try {
    return new URL(ref).pathname || '/';
  } catch {
    return '';
  }
}

function collectStrings(value: unknown, out: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Accepts whatever a beacon or a form happens to send: a JSON object, a
 * urlencoded body, or a bare `p=/path/` string. A `text/plain` beacon is
 * preferred on the client because it stays a CORS-simple request (no preflight).
 */
async function readLooseBody(request: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const raw = await request.text();
    if (!raw) return out;
    if (raw.trimStart().startsWith('{')) {
      try {
        return collectStrings(JSON.parse(raw), out);
      } catch {
        /* fall through to form parsing */
      }
    }
    for (const [k, v] of new URLSearchParams(raw)) if (v) out[k] = v;
  } catch {
    /* malformed body: fall back to the query string */
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function methodNotAllowed(cors: Record<string, string>): Response {
  return json({ error: 'Method Not Allowed' }, 405, cors);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}
