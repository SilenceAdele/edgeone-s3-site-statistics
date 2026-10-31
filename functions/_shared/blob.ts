/**
 * Optional snapshot cache on Pages Blob.
 *
 * EdgeOne does NOT CDN-cache edge function responses, so every visit to the
 * blog would otherwise cost several S3 reads. One small snapshot JSON, refreshed
 * at most once per TTL, collapses that to a single Blob read.
 *
 * Two rules learned from edgeone-s3-proxy:
 *   1. Use a dedicated store name. That project FIFO-evicts any key missing from
 *      its own __index__ manifest, so sharing `s3-cache` would delete our keys.
 *   2. Treat the SDK as optional. Any failure must degrade to direct S3 reads.
 */

let _store: any = null;
let _tried = false;
let _triedName = '';

/** Lazily import so a missing package degrades instead of breaking the service. */
export async function getBlobStore(name: string): Promise<any> {
  if (_tried && _triedName === name) return _store;
  _tried = true;
  _triedName = name;
  try {
    const mod: any = await import('@edgeone/pages-blob');
    _store = mod.getStore(name);
  } catch {
    _store = null;
  }
  return _store;
}

export interface StoredJson<T> {
  value: T;
  /** Epoch ms recorded when the value was written, or 0 if unknown. */
  at: number;
}

export async function blobReadJson<T = unknown>(
  store: any,
  key: string,
): Promise<StoredJson<T> | null> {
  if (!store) return null;
  try {
    const raw = await store.get(key, { type: 'text' });
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { value: parsed as T, at: Number((parsed as any).at) || 0 };
  } catch {
    return null;
  }
}

/** Store a JSON value, timestamping it so readers can apply a TTL. */
export async function blobWriteJson(store: any, key: string, value: object): Promise<boolean> {
  if (!store) return false;
  try {
    await store.setJSON(key, { ...value, at: Date.now() });
    return true;
  } catch {
    return false;
  }
}
