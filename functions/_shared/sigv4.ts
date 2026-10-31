/**
 * AWS Signature V4 for the S3-compatible gateway, implemented with Web Crypto.
 *
 * The gateway in front of the bucket only accepts requests where:
 *   - the signed header set is exactly `host;x-amz-content-sha256;x-amz-date`
 *   - `User-Agent` matches the application the AccessKey is bound to
 *
 * `User-Agent` is sent UNSIGNED (SigV4 permits unsigned headers). `Host` is
 * never set as a request header — the platform derives it from the URL — but it
 * is still part of the canonical request. Both choices were measured against
 * the real gateway, not guessed.
 */

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const input = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', input));
}

async function hmacRaw(key: BufferSource | Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? enc.encode(key) : (key as BufferSource);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data)));
}

export async function hmacHex(key: string, data: string): Promise<string> {
  return toHex(await hmacRaw(key, data));
}

/**
 * AWS URI encoding: every character except unreserved ones is escaped, `!'()*`
 * included, while `/` stays a separator. Applied per path segment.
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg)
        .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
        .replace(/%2F/gi, '/'),
    )
    .join('/');
}

/**
 * Canonical query string: keys sorted, both sides URI-encoded.
 *
 * Getting this wrong is the classic SigV4 failure — an unsigned-sorted query
 * produces 401 SignatureDoesNotMatch, not a helpful error.
 */
export function canonicalQuery(query?: Record<string, string>): string {
  if (!query) return '';
  return Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? '')}`)
    .join('&');
}

export interface SignInput {
  method: string;
  host: string;
  /** Raw (unencoded) absolute path, e.g. `/bucket/stats/agg/total.json`. */
  path: string;
  query?: Record<string, string>;
  /** SHA-256 hex of the request body; empty-body hash for GET/HEAD/DELETE. */
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  uaPrefix: string;
  now?: Date;
}

export interface SignedHeaders {
  headers: Record<string, string>;
  /** The exact path + query the signature was computed over, used to build the URL. */
  target: string;
  amzDate: string;
}

export async function signRequest(input: SignInput): Promise<SignedHeaders> {
  const service = input.service || 's3';
  const now = input.now || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261031T120000Z
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = encodePath(input.path);
  const canonicalQueryString = canonicalQuery(input.query);

  const canonicalHeaders =
    [`host:${input.host}`, `x-amz-content-sha256:${input.payloadHash}`, `x-amz-date:${amzDate}`].join(
      '\n',
    ) + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  let key = await hmacRaw(`AWS4${input.secretAccessKey}`, dateStamp);
  key = await hmacRaw(key, input.region);
  key = await hmacRaw(key, service);
  key = await hmacRaw(key, 'aws4_request');
  const signature = toHex(await hmacRaw(key, stringToSign));

  return {
    amzDate,
    target: canonicalUri + (canonicalQueryString ? `?${canonicalQueryString}` : ''),
    headers: {
      // Host is derived from the URL by the platform; signing it is enough.
      'x-amz-content-sha256': input.payloadHash,
      'x-amz-date': amzDate,
      // The gateway gates on this header; it must match UA_PREFIX.
      'User-Agent': `${input.uaPrefix} edgeone-s3-site-statistics/1.0`,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
