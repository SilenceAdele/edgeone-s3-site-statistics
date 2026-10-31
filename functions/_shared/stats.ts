/**
 * Statistics core: event keys -> daily -> monthly -> total -> snapshot.
 *
 * Design constraint: the storage is plain S3 with no atomic increments and no
 * conditional writes (the gateway ignores `If-None-Match: *`, ETags are UUIDs).
 * So nothing is ever incremented. A page view is an immutable object whose
 * *key* carries all the information; every aggregate is recomputed from those
 * inputs and can be repeated any number of times with the same result.
 *
 *   stats/e/<YYYY-MM-DD>/<b64url(path)>/<ms>-<visitorHash>-<rand>   (0 bytes)
 *   stats/agg/daily/<YYYY-MM-DD>.json
 *   stats/agg/month/<YYYY-MM>.json
 *   stats/agg/total.json
 *
 * UV definition: unique visitor-*days*. A visitor is a daily-salted HMAC of
 * IP+User-Agent; nothing identifying is stored and the hash rotates every day,
 * so total UV is the sum of daily UV, not the count of distinct people.
 */

import { hmacHex } from './sigv4.ts';
import {
  s3Delete,
  s3GetJson,
  s3ListKeys,
  s3PutEmpty,
  s3PutJson,
  type S3Config,
} from './s3.ts';
import { blobReadJson, blobWriteJson } from './blob.ts';

export const SNAPSHOT_KEY = 'snapshot/v1.json';
const MAX_MONTHS = 240;
const DELETE_CONCURRENCY = 8;
// Edge functions cap the number of outbound subrequests. Deletions are pure
// housekeeping — the numbers are already committed to the daily file — so a
// backlog is trimmed a slice at a time instead of failing the whole rebuild.
const MAX_DELETIONS = 200;

export interface Counter {
  pv: number;
  uv: number;
}

export interface DayDoc {
  date: string;
  site: Counter;
  pages: Record<string, Counter>;
  updatedAt: number;
}

export interface MonthDoc {
  month: string;
  site: Counter;
  pages: Record<string, Counter>;
  days: string[];
  updatedAt: number;
}

export interface TotalDoc {
  site: Counter;
  pages: Record<string, Counter>;
  updatedAt: number;
}

export interface Snapshot {
  at: number;
  version: 1;
  updatedAt: number;
  total: TotalDoc;
  today: DayDoc;
  yesterday: DayDoc;
}

export interface StatsPayload {
  site_pv: number;
  site_uv: number;
  page_pv: number;
  page_uv: number;
  today: { site_pv: number; site_uv: number; page_pv: number; page_uv: number };
  yesterday: { site_pv: number; site_uv: number; page_pv: number; page_uv: number };
  updatedAt: number;
  servedAt: number;
}

export interface StatsConfig {
  s3: S3Config;
  prefix: string;
  salt: string;
  tzOffset: number;
  keepDays: number;
  snapshotTtlMs: number;
  store: any;
}

export interface AggregateResult {
  today: string;
  events: number;
  days: number;
  months: string[];
  cleaned: number;
  pendingDeletes: number;
  ignored: number;
}

// ---------- calendar ----------

export function dayString(now: Date, tzOffset: number): string {
  return new Date(now.getTime() + tzOffset * 3600_000).toISOString().slice(0, 10);
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

// ---------- page keys ----------

/**
 * Normalize a page path into a stable key.
 *
 * The path arrives from the browser, so it is untrusted: query/hash stripped,
 * slashes collapsed, control characters removed, length capped. It never
 * reaches the storage path directly — it is base64url-encoded first.
 */
export function normalizePath(raw: string): string {
  let p = String(raw ?? '')
    .split('#')[0]
    .split('?')[0]
    .replace(/[\u0000-\u001f\u007f]/g, '');
  if (!p) return '/';
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p === '/index.html') p = '/';
  if (p.length > 400) p = p.slice(0, 400);
  return p || '/';
}

export function encodePageKey(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodePageKey(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------- keys ----------

function eventPrefix(prefix: string): string {
  return `${prefix}/e/`;
}

function dailyKey(prefix: string, day: string): string {
  return `${prefix}/agg/daily/${day}.json`;
}

function monthKey(prefix: string, month: string): string {
  return `${prefix}/agg/month/${month}.json`;
}

function totalKey(prefix: string): string {
  return `${prefix}/agg/total.json`;
}

/** Visitor identity for one day: daily-salted, truncated, one-way. */
export async function visitorHash(
  salt: string,
  day: string,
  ip: string,
  userAgent: string,
): Promise<string> {
  return (await hmacHex(`${salt}|${day}`, `${ip}|${userAgent}`)).slice(0, 16);
}

export function newEventKey(
  prefix: string,
  day: string,
  page: string,
  hash: string,
  nowMs: number,
): string {
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${eventPrefix(prefix)}${day}/${encodePageKey(page)}/${nowMs}-${hash}-${rand}`;
}

const EVENT_TAIL = /^(\d+)-([0-9a-f]{16})-([0-9a-f]{4})$/;

interface ParsedEvent {
  key: string;
  day: string;
  page: string;
  visitor: string;
}

function parseEventKey(prefix: string, key: string): ParsedEvent | null {
  const base = eventPrefix(prefix);
  if (!key.startsWith(base)) return null;
  const parts = key.slice(base.length).split('/');
  if (parts.length !== 3) return null;
  const [day, pageKey, tail] = parts;
  let page: string;
  try {
    page = decodePageKey(pageKey);
  } catch {
    return null;
  }
  const m = EVENT_TAIL.exec(tail);
  // A malformed tail still counts as a view; it just cannot contribute to UV.
  return { key, day, page, visitor: m ? m[2] : '' };
}

// ---------- counting ----------

function countDay(day: string, events: ParsedEvent[], nowMs: number): DayDoc {
  const pages = new Map<string, { pv: number; seen: Set<string> }>();
  const siteSeen = new Set<string>();

  for (const e of events) {
    const acc = pages.get(e.page) || { pv: 0, seen: new Set<string>() };
    acc.pv += 1;
    if (e.visitor) {
      acc.seen.add(e.visitor);
      siteSeen.add(e.visitor);
    }
    pages.set(e.page, acc);
  }

  const out: Record<string, Counter> = {};
  for (const [path, acc] of pages) out[path] = { pv: acc.pv, uv: acc.seen.size };

  return {
    date: day,
    site: { pv: events.length, uv: siteSeen.size },
    pages: out,
    updatedAt: nowMs,
  };
}

function sameCounters(a?: Counter, b?: Counter): boolean {
  return (a?.pv ?? 0) === (b?.pv ?? 0) && (a?.uv ?? 0) === (b?.uv ?? 0);
}

function samePages(a?: Record<string, Counter>, b?: Record<string, Counter>): boolean {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameCounters(a![k], b![k])) return false;
  return true;
}

function sameDay(a: DayDoc | null, b: DayDoc): boolean {
  return !!a && sameCounters(a.site, b.site) && samePages(a.pages, b.pages);
}

function sumPages(into: Record<string, Counter>, from: Record<string, Counter>): void {
  for (const [k, v] of Object.entries(from || {})) {
    const slot = (into[k] ||= { pv: 0, uv: 0 });
    slot.pv += v.pv || 0;
    slot.uv += v.uv || 0;
  }
}

// ---------- aggregation ----------

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

async function recomputeMonth(cfg: StatsConfig, month: string): Promise<MonthDoc> {
  // The gateway only honours LIST prefixes that end at a `/` boundary: asking
  // for `agg/daily/2026-10-` returns nothing at all. So list the whole daily
  // directory once and filter by month on the client.
  const base = `${cfg.prefix}/agg/daily/`;
  const keys = (await s3ListKeys(cfg.s3, base)).filter(
    (k) => k.startsWith(`${base}${month}-`) && k.endsWith('.json'),
  );
  const site: Counter = { pv: 0, uv: 0 };
  const pages: Record<string, Counter> = {};
  const days: string[] = [];

  for (const key of keys.sort()) {
    const doc = await s3GetJson<DayDoc>(cfg.s3, key);
    if (!doc || !doc.date) continue;
    days.push(doc.date);
    site.pv += doc.site?.pv || 0;
    site.uv += doc.site?.uv || 0;
    sumPages(pages, doc.pages);
  }

  return { month, site, pages, days, updatedAt: Date.now() };
}

async function recomputeTotal(cfg: StatsConfig): Promise<TotalDoc> {
  const keys = (await s3ListKeys(cfg.s3, `${cfg.prefix}/agg/month/`))
    .filter((k) => k.endsWith('.json'))
    .sort()
    .slice(-MAX_MONTHS);
  const site: Counter = { pv: 0, uv: 0 };
  const pages: Record<string, Counter> = {};

  for (const key of keys) {
    const doc = await s3GetJson<MonthDoc>(cfg.s3, key);
    if (!doc) continue;
    site.pv += doc.site?.pv || 0;
    site.uv += doc.site?.uv || 0;
    sumPages(pages, doc.pages);
  }

  return { site, pages, updatedAt: Date.now() };
}

function sameMonth(a: MonthDoc | null, b: MonthDoc): boolean {
  if (!a) return false;
  return (
    sameCounters(a.site, b.site) &&
    samePages(a.pages, b.pages) &&
    (a.days || []).join(',') === b.days.join(',')
  );
}

function sameTotal(a: TotalDoc | null, b: TotalDoc): boolean {
  return !!a && sameCounters(a.site, b.site) && samePages(a.pages, b.pages);
}

function emptyDay(day: string, nowMs: number): DayDoc {
  return { date: day, site: { pv: 0, uv: 0 }, pages: {}, updatedAt: nowMs };
}

/**
 * Rebuild every derived file from the raw event objects.
 *
 * Idempotent: running it twice, or concurrently from two isolates, converges on
 * the same numbers because nothing is incremented in place.
 */
export async function aggregate(cfg: StatsConfig): Promise<AggregateResult> {
  const nowMs = Date.now();
  const today = dayString(new Date(nowMs), cfg.tzOffset);
  const cutoff = shiftDay(today, -cfg.keepDays);

  const keys = await s3ListKeys(cfg.s3, eventPrefix(cfg.prefix));
  const byDay = new Map<string, ParsedEvent[]>();
  let eventCount = 0;
  let ignored = 0;

  for (const key of keys) {
    if (key.endsWith('/')) continue; // directory marker, not an event
    const parsed = parseEventKey(cfg.prefix, key);
    if (!parsed) {
      ignored += 1;
      continue;
    }
    eventCount += 1;
    const bucket = byDay.get(parsed.day) || [];
    bucket.push(parsed);
    byDay.set(parsed.day, bucket);
  }

  const changedDays = new Set<string>();
  const staleKeys: string[] = [];
  const docs = new Map<string, DayDoc | null>();

  for (const [day, events] of byDay) {
    const fresh = countDay(day, events, nowMs);

    // Too old to recompute: its events were (or are about to be) deleted. Only
    // backfill the daily file if a previous run crashed before writing it.
    if (day < cutoff) {
      const existing = await s3GetJson<DayDoc>(cfg.s3, dailyKey(cfg.prefix, day));
      if (!existing) {
        await s3PutJson(cfg.s3, dailyKey(cfg.prefix, day), fresh);
        changedDays.add(day);
      }
      for (const e of events) staleKeys.push(e.key);
      continue;
    }

    const existing = await s3GetJson<DayDoc>(cfg.s3, dailyKey(cfg.prefix, day));
    if (!sameDay(existing, fresh)) {
      await s3PutJson(cfg.s3, dailyKey(cfg.prefix, day), fresh);
      changedDays.add(day);
      docs.set(day, fresh);
    } else if (day === today) {
      // Heartbeat: same numbers, refreshed timestamp, so staleness is visible.
      const heartbeat = { ...fresh, updatedAt: nowMs };
      await s3PutJson(cfg.s3, dailyKey(cfg.prefix, day), heartbeat);
      docs.set(day, heartbeat);
    } else {
      docs.set(day, existing);
    }
  }

  const deleting = staleKeys.slice(0, MAX_DELETIONS);
  if (deleting.length) {
    await mapLimit(deleting, DELETE_CONCURRENCY, async (key) => {
      try {
        await s3Delete(cfg.s3, key);
      } catch {
        /* retried on the next run */
      }
    });
  }

  const months = new Set<string>();
  for (const day of changedDays) months.add(monthOf(day));
  months.add(monthOf(today));

  const changedMonths: string[] = [];
  for (const month of months) {
    const existing = await s3GetJson<MonthDoc>(cfg.s3, monthKey(cfg.prefix, month));
    const forced = [...changedDays].some((d) => monthOf(d) === month);
    if (!forced && existing) continue;

    const fresh = await recomputeMonth(cfg, month);
    if (!sameMonth(existing, fresh)) {
      await s3PutJson(cfg.s3, monthKey(cfg.prefix, month), fresh);
      changedMonths.push(month);
    }
  }

  let total = await s3GetJson<TotalDoc>(cfg.s3, totalKey(cfg.prefix));
  if (changedMonths.length || !total) {
    const fresh = await recomputeTotal(cfg);
    if (!sameTotal(total, fresh)) {
      await s3PutJson(cfg.s3, totalKey(cfg.prefix), fresh);
      total = fresh;
    }
  }

  const yesterday = shiftDay(today, -1);
  const todayDoc = docs.get(today) || (await s3GetJson<DayDoc>(cfg.s3, dailyKey(cfg.prefix, today)));
  const yesterdayDoc =
    docs.get(yesterday) || (await s3GetJson<DayDoc>(cfg.s3, dailyKey(cfg.prefix, yesterday)));

  const snap: Snapshot = {
    version: 1,
    at: nowMs,
    updatedAt: nowMs,
    total: total || { site: { pv: 0, uv: 0 }, pages: {}, updatedAt: nowMs },
    today: todayDoc || emptyDay(today, nowMs),
    yesterday: yesterdayDoc || emptyDay(yesterday, nowMs),
  };

  await writeSnapshot(cfg, snap);
  rememberSnapshot(cfg, snap);

  return {
    today,
    events: eventCount,
    days: byDay.size,
    months: changedMonths,
    cleaned: deleting.length,
    pendingDeletes: staleKeys.length - deleting.length,
    ignored,
  };
}

// ---------- snapshot ----------

/**
 * Isolate-local cache. Without Pages Blob every read would be three S3 GETs,
 * which the gateway rate-limits under a burst; one snapshot per isolate serves
 * the whole TTL instead.
 */
let memory: { key: string; snap: Snapshot } | null = null;

function memoryKey(cfg: StatsConfig): string {
  return `${cfg.prefix}|${cfg.tzOffset}`;
}

function rememberSnapshot(cfg: StatsConfig, snap: Snapshot): void {
  memory = { key: memoryKey(cfg), snap };
}

function recallSnapshot(cfg: StatsConfig, nowMs: number): Snapshot | null {
  if (!memory || memory.key !== memoryKey(cfg)) return null;
  return nowMs - memory.snap.at <= cfg.snapshotTtlMs ? memory.snap : null;
}

async function writeSnapshot(cfg: StatsConfig, snap: Snapshot): Promise<void> {
  await blobWriteJson(cfg.store, SNAPSHOT_KEY, snap);
}

async function readSnapshot(cfg: StatsConfig): Promise<Snapshot | null> {
  const stored = await blobReadJson<Snapshot>(cfg.store, SNAPSHOT_KEY);
  if (!stored || !stored.value || !(stored.value as any).total) return null;
  return { ...stored.value, at: stored.at || Number(stored.value.at) || 0 };
}

/** Fallback when Pages Blob is unavailable: read the three files directly. */
export async function buildSnapshotFromS3(cfg: StatsConfig): Promise<Snapshot | null> {
  const nowMs = Date.now();
  const today = dayString(new Date(nowMs), cfg.tzOffset);
  const yesterday = shiftDay(today, -1);

  const total = await s3GetJson<TotalDoc>(cfg.s3, totalKey(cfg.prefix));
  if (!total) return null;

  const [todayDoc, yesterdayDoc] = await Promise.all([
    s3GetJson<DayDoc>(cfg.s3, dailyKey(cfg.prefix, today)),
    s3GetJson<DayDoc>(cfg.s3, dailyKey(cfg.prefix, yesterday)),
  ]);

  return {
    version: 1,
    at: nowMs,
    updatedAt: nowMs,
    total,
    today: todayDoc || emptyDay(today, nowMs),
    yesterday: yesterdayDoc || emptyDay(yesterday, nowMs),
  };
}

// ---------- projection ----------

function pageCounter(totals: Record<string, Counter> | undefined, path: string): Counter {
  return totals?.[path] || { pv: 0, uv: 0 };
}

export function project(snap: Snapshot | null, path: string, nowMs: number): StatsPayload {
  const site = snap?.total?.site || { pv: 0, uv: 0 };
  const page = pageCounter(snap?.total?.pages, path);
  const todaySite = snap?.today?.site || { pv: 0, uv: 0 };
  const yesterdaySite = snap?.yesterday?.site || { pv: 0, uv: 0 };

  return {
    site_pv: site.pv,
    site_uv: site.uv,
    page_pv: page.pv,
    page_uv: page.uv,
    today: {
      site_pv: todaySite.pv,
      site_uv: todaySite.uv,
      page_pv: snap?.today?.pages?.[path]?.pv || 0,
      page_uv: snap?.today?.pages?.[path]?.uv || 0,
    },
    yesterday: {
      site_pv: yesterdaySite.pv,
      site_uv: yesterdaySite.uv,
      page_pv: snap?.yesterday?.pages?.[path]?.pv || 0,
      page_uv: snap?.yesterday?.pages?.[path]?.uv || 0,
    },
    updatedAt: snap?.updatedAt || 0,
    servedAt: nowMs,
  };
}

// ---------- read path ----------

export interface StatsRead {
  payload: StatsPayload;
  /** False means the caller should refresh the snapshot in the background. */
  fresh: boolean;
}

/**
 * Read counters for one page.
 *
 * Never throws: a counter is decoration on someone's page, so a rate-limited or
 * unreachable gateway degrades to the last known snapshot (or to zeros) instead
 * of a 500.
 */
export async function getStats(cfg: StatsConfig, rawPath: string): Promise<StatsRead> {
  const nowMs = Date.now();
  const path = normalizePath(rawPath);

  if (!cfg.store) {
    const cached = recallSnapshot(cfg, nowMs);
    if (cached) return { payload: project(cached, path, nowMs), fresh: true };

    try {
      const snap = await buildSnapshotFromS3(cfg);
      if (snap) {
        rememberSnapshot(cfg, snap);
        return { payload: project(snap, path, nowMs), fresh: false };
      }
    } catch {
      /* gateway throttled: serve whatever this isolate remembers */
    }
    const stale = memory && memory.key === memoryKey(cfg) ? memory.snap : null;
    return { payload: project(stale, path, nowMs), fresh: false };
  }

  const snap = await readSnapshot(cfg);
  if (snap) {
    return { payload: project(snap, path, nowMs), fresh: nowMs - snap.at <= cfg.snapshotTtlMs };
  }

  // Cold start: no snapshot yet, so pay the aggregation cost once.
  try {
    await aggregate(cfg);
  } catch {
    /* fall through with zeros */
  }
  const built = await readSnapshot(cfg);
  return { payload: project(built, path, nowMs), fresh: !!built };
}

// ---------- event write ----------

export async function recordHit(opts: {
  s3: S3Config;
  prefix: string;
  salt: string;
  tzOffset: number;
  page: string;
  ip: string;
  userAgent: string;
  nowMs?: number;
}): Promise<string> {
  const nowMs = opts.nowMs ?? Date.now();
  const day = dayString(new Date(nowMs), opts.tzOffset);
  const hash = await visitorHash(opts.salt, day, opts.ip, opts.userAgent);
  const key = newEventKey(opts.prefix, day, normalizePath(opts.page), hash, nowMs);
  await s3PutEmpty(opts.s3, key);
  return key;
}
