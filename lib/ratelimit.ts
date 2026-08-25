import { getDb } from "./db";

// the three billed/costly operations this module bounds. tailoring is a Gemini call charged to the
// owner's key; compiling pins the CPU inside tectonic; scraping is an outbound fetch to a
// third-party site. each gets its own budget below.
export type UsageKind = "tailor" | "compile" | "scrape";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface KindLimit {
  limit: number;
  windowSeconds: number;
}

// one obvious place for the numbers, each env-overridable in lib/config.ts's `Number(process.env.X)
// || default` style. invite-only with ~10 users, so every default is picked to never bother a real
// person while still bounding what one runaway client loop (or malicious invitee) can do overnight.
export const RATE_LIMITS: Record<UsageKind, KindLimit> = {
  // a model call billed to the owner's Gemini key and tens of seconds each; a real job search
  // doesn't produce more than a handful of tailoring runs a day, so 20/day leaves generous room
  // while capping a runaway loop's damage to the key to 20 calls before it has to wait
  tailor: {
    limit: Number(process.env.RATE_LIMIT_TAILOR_PER_DAY) || 20,
    windowSeconds: 24 * 60 * 60,
  },
  // LaTeX compiles pin the CPU; 30/hour comfortably covers iterating on one application (edit,
  // recompile, repeat) while still bounding how long a compile loop can hold the box
  compile: {
    limit: Number(process.env.RATE_LIMIT_COMPILE_PER_HOUR) || 30,
    windowSeconds: 60 * 60,
  },
  // cheap on the server, but it's an outbound fetch to a site this app doesn't control; 60/hour is
  // far above anything a person browsing job postings by hand would hit
  scrape: {
    limit: Number(process.env.RATE_LIMIT_SCRAPE_PER_HOUR) || 60,
    windowSeconds: 60 * 60,
  },
};

// the longest window across all kinds is the safe global prune cutoff: a row older than this has
// aged out of every kind's window and can never again affect a checkRateLimit result
const LONGEST_WINDOW_SECONDS = Math.max(...Object.values(RATE_LIMITS).map((k) => k.windowSeconds));

interface UsageEventRow {
  created_at: string;
}

function windowRows(
  userId: string,
  kind: UsageKind,
  now: Date,
  windowSeconds: number
): UsageEventRow[] {
  const conn = getDb();
  const windowStartIso = new Date(now.getTime() - windowSeconds * 1000).toISOString();

  // oldest-first over the (user_id, kind, created_at) index: rows[0] (if any) is exactly the event
  // whose aging-out determines retryAfterSeconds below.
  return conn
    .prepare(
      "SELECT created_at FROM usage_events WHERE user_id = ? AND kind = ? AND created_at > ? ORDER BY created_at ASC"
    )
    .all(userId, kind, windowStartIso) as UsageEventRow[];
}

function buildRateLimitResult(
  rows: UsageEventRow[],
  limit: number,
  windowSeconds: number,
  now: Date,
  allowed: boolean,
  remaining: number
): RateLimitResult {
  let retryAfterSeconds = 0;
  if (!allowed && rows[0]) {
    const oldestAgesOutAt = new Date(rows[0].created_at).getTime() + windowSeconds * 1000;
    retryAfterSeconds = Math.max(0, Math.ceil((oldestAgesOutAt - now.getTime()) / 1000));
  }

  return { allowed, limit, remaining: Math.max(0, remaining), retryAfterSeconds };
}

function pruneOldRows(now: Date): void {
  const cutoffIso = new Date(now.getTime() - LONGEST_WINDOW_SECONDS * 1000).toISOString();
  getDb().prepare("DELETE FROM usage_events WHERE created_at < ?").run(cutoffIso);
}

/**
 * Read-only: counts this user's events for `kind` in the trailing window ending at `now` and
 * reports whether another one is allowed. Does NOT insert a row. Use reserveRateLimit() at the
 * point a route is about to start expensive work; a separate read-only precheck cannot protect
 * against concurrent bursts.
 *
 * `now` defaults to the real clock but is an explicit parameter so tests can drive it directly
 * instead of mocking Date.
 */
export function checkRateLimit(userId: string, kind: UsageKind, now: Date = new Date()): RateLimitResult {
  const { limit, windowSeconds } = RATE_LIMITS[kind];
  const rows = windowRows(userId, kind, now, windowSeconds);
  return buildRateLimitResult(rows, limit, windowSeconds, now, rows.length < limit, limit - rows.length);
}

/**
 * Atomically reserves one usage slot for `userId`/`kind` if a slot is still available. This is the
 * function routes should call immediately before expensive work: the count and insert happen inside
 * one BEGIN IMMEDIATE transaction, so concurrent requests cannot all pass the same stale precheck.
 *
 * A successful reservation is deliberately not rolled back when the guarded compile/model/fetch
 * later fails. The resource was already spent by that point, and letting failures stay free makes a
 * broken document or bad provider loop an unbounded CPU/API sink.
 */
export function reserveRateLimit(userId: string, kind: UsageKind, now: Date = new Date()): RateLimitResult {
  const { limit, windowSeconds } = RATE_LIMITS[kind];
  const conn = getDb();

  const reserve = conn.transaction(() => {
    const rows = windowRows(userId, kind, now, windowSeconds);

    // boundary choice: `limit` is the max number of events allowed inside the window, so being AT
    // the limit refuses the next reservation.
    if (rows.length >= limit) {
      return buildRateLimitResult(rows, limit, windowSeconds, now, false, 0);
    }

    conn.prepare("INSERT INTO usage_events (user_id, kind, created_at) VALUES (?, ?, ?)").run(
      userId,
      kind,
      now.toISOString()
    );
    pruneOldRows(now);
    return buildRateLimitResult(rows, limit, windowSeconds, now, true, limit - rows.length - 1);
  });

  return reserve.immediate();
}

/**
 * Records one usage event for `userId`/`kind` at `now`, then prunes everything older than the
 * longest window. Prefer reserveRateLimit() in routes that guard expensive work; this helper remains
 * for tests and narrowly-scoped callers that intentionally account usage after an already-completed
 * operation.
 *
 * The prune is unscoped by user/kind on purpose: the concern is total table growth ("grows forever
 * otherwise"), not any one caller's rows, and the longest-window cutoff is safe for every kind at
 * once. This is a plain DELETE on created_at, not the (user_id, kind, created_at) index, so it's a
 * full scan -- fine at ~10 users' worth of rows, and adding a second index is out of scope for this
 * file.
 */
export function recordUsage(userId: string, kind: UsageKind, now: Date = new Date()): void {
  const conn = getDb();
  const nowIso = now.toISOString();

  conn.prepare("INSERT INTO usage_events (user_id, kind, created_at) VALUES (?, ?, ?)").run(userId, kind, nowIso);
  pruneOldRows(now);
}
