/**
 * Minimal S3 client: only what the stats service needs (GET / PUT / DELETE /
 * ListObjectsV2), path-style addressing, SigV4 signed through `./sigv4.ts`.
 *
 * The gateway ignores `If-None-Match: *` and reports UUID ETags, so this client
 * never relies on conditional writes. Idempotency is achieved by recomputing
 * aggregates from immutable inputs instead of incrementing shared counters.
 */

import { sha256Hex, signRequest } from './sigv4.ts';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MAX_LIST_PAGES = 50;

export interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Hostname only, no scheme. */
  host: string;
  region: string;
  uaPrefix: string;
}

export interface ConfigRead {
  config: S3Config | null;
  missing: string[];
}

function isPlaceholder(v: string): boolean {
  return /REPLACE|your-|example|xxx|TODO|CHANGEME/i.test(v);
}

export function readS3Config(env: Record<string, string | undefined>): ConfigRead {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const bucket = env.S3_BUCKET;
  const endpoint = env.S3_ENDPOINT;

  const pairs: Array<[string, string | undefined]> = [
    ['AWS_ACCESS_KEY_ID', accessKeyId],
    ['AWS_SECRET_ACCESS_KEY', secretAccessKey],
    ['S3_BUCKET', bucket],
    ['S3_ENDPOINT', endpoint],
  ];
  const missing = pairs.filter(([, v]) => !v || isPlaceholder(v)).map(([k]) => k);
  if (missing.length) return { config: null, missing };

  return {
    config: {
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      bucket: bucket!,
      host: endpoint!.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      region: env.S3_REGION || 'cn-north-1',
      uaPrefix: env.UA_PREFIX || 'S3Drive',
    },
    missing: [],
  };
}

interface S3RequestInput {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Object key, `''` for the bucket root. */
  key: string;
  query?: Record<string, string>;
  body?: Uint8Array;
}

// The gateway rate-limits bursts (429) and occasionally answers 5xx when its
// own backend hiccups. Every request here is idempotent — GET, DELETE, and a
// PUT to a key that already encodes the payload — so a short retry is safe.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function s3Request(cfg: S3Config, input: S3RequestInput): Promise<Response> {
  const body = input.body ?? new Uint8Array(0);
  const payloadHash = body.byteLength ? await sha256Hex(body) : EMPTY_SHA256;
  const path = input.key ? `/${cfg.bucket}/${input.key}` : `/${cfg.bucket}`;

  const signed = await signRequest({
    method: input.method,
    host: cfg.host,
    path,
    query: input.query,
    payloadHash,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    uaPrefix: cfg.uaPrefix,
  });

  const init: RequestInit = { method: input.method, headers: signed.headers };
  if (input.method === 'PUT') init.body = body;
  const url = `https://${cfg.host}${signed.target}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS - 1) return res;
      // 429 is a quota/throttle signal and needs a longer pause than a 5xx blip.
      await sleep((res.status === 429 ? 400 : 150) * 2 ** attempt);
    } catch (e) {
      lastError = e;
      if (attempt === MAX_ATTEMPTS - 1) throw e;
      await sleep(150 * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('S3 request failed');
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * List every key under `prefix`.
 *
 * The gateway reports MaxKeys=100000 and returns the whole set in one page, but
 * pagination is implemented anyway so a stricter S3 would not silently truncate.
 */
export async function s3ListKeys(cfg: S3Config, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token = '';

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query: Record<string, string> = {
      'list-type': '2',
      'max-keys': '1000',
      prefix,
    };
    if (token) query['continuation-token'] = token;

    const res = await s3Request(cfg, { method: 'GET', key: '', query });
    if (!res.ok) throw new Error(`S3 list ${res.status}`);
    const xml = await res.text();

    // Note: the gateway materialises a zero-byte "directory marker" for every
    // parent prefix it creates (e.g. `<prefix>/agg/month/`). Keys ending in `/`
    // are those markers, not objects: they cannot be read back (GET returns
    // 500), so callers must skip them.
    for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(decodeXml(m[1]));
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;

    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    if (!next) break;
    token = decodeXml(next[1]);
  }

  return keys;
}

export async function s3GetText(cfg: S3Config, key: string): Promise<string | null> {
  const res = await s3Request(cfg, { method: 'GET', key });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`S3 get ${key} ${res.status}`);
  return res.text();
}

export async function s3GetJson<T = unknown>(cfg: S3Config, key: string): Promise<T | null> {
  const raw = await s3GetText(cfg, key);
  if (raw === null || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function s3PutJson(cfg: S3Config, key: string, value: unknown): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const res = await s3Request(cfg, { method: 'PUT', key, body });
  if (!res.ok) throw new Error(`S3 put ${key} ${res.status}`);
}

/** Zero-byte object. The event payload lives entirely in the key. */
export async function s3PutEmpty(cfg: S3Config, key: string): Promise<void> {
  const res = await s3Request(cfg, { method: 'PUT', key });
  if (!res.ok) throw new Error(`S3 put ${key} ${res.status}`);
}

export async function s3Delete(cfg: S3Config, key: string): Promise<void> {
  const res = await s3Request(cfg, { method: 'DELETE', key });
  // S3 returns 204 for both "deleted" and "did not exist".
  if (!res.ok && res.status !== 404) throw new Error(`S3 delete ${key} ${res.status}`);
}
