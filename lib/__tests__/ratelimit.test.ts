import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "../db";
import { checkRateLimit, recordUsage, RATE_LIMITS } from "../ratelimit";

// each test gets its own temp-file db path so tests never share state or clobber the real tracker.db;
// getDb(dbPath) re-points the module's memoized connection at that path for the duration of the test
function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-ratelimit-")), "tracker.db");
}

// time is always passed explicitly to checkRateLimit/recordUsage below -- never Date.now() or
// vi.useFakeTimers -- so these tests are deterministic regardless of how long they take to run
const BASE = new Date("2026-01-01T00:00:00.000Z");

describe("ratelimit", () => {
  let dbDir: string;

  afterEach(() => {
    if (dbDir && fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("allows requests under the limit", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const limit = RATE_LIMITS.compile.limit;
    for (let i = 0; i < limit - 1; i++) {
      recordUsage("user-1", "compile", BASE);
    }

    const result = checkRateLimit("user-1", "compile", BASE);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it("refuses exactly AT the limit (limit is the max allowed inside the window)", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const limit = RATE_LIMITS.compile.limit;
    for (let i = 0; i < limit; i++) {
      recordUsage("user-1", "compile", BASE);
    }

    const result = checkRateLimit("user-1", "compile", BASE);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(limit);
  });

  it("refuses over the limit", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const limit = RATE_LIMITS.compile.limit;
    for (let i = 0; i < limit + 5; i++) {
      recordUsage("user-1", "compile", BASE);
    }

    const result = checkRateLimit("user-1", "compile", BASE);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("rolls the window: an aging-out event frees a slot", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const { limit, windowSeconds } = RATE_LIMITS.compile;
    // one event strictly older than the rest, so only its aging-out (not everyone's at once) moves
    // the count -- recording all of them at the identical instant would age them out together
    recordUsage("user-1", "compile", BASE);
    const secondOnward = new Date(BASE.getTime() + 2_000);
    for (let i = 0; i < limit - 1; i++) {
      recordUsage("user-1", "compile", secondOnward);
    }

    // 1s before the oldest event ages out: still at the limit, refused
    const justBefore = new Date(BASE.getTime() + (windowSeconds - 1) * 1000);
    expect(checkRateLimit("user-1", "compile", justBefore).allowed).toBe(false);

    // 1s after the oldest event ages out: one slot freed
    const justAfter = new Date(BASE.getTime() + (windowSeconds + 1) * 1000);
    const rolled = checkRateLimit("user-1", "compile", justAfter);
    expect(rolled.allowed).toBe(true);
    expect(rolled.remaining).toBe(1);
  });

  it("gives independent budgets per kind", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const tailorLimit = RATE_LIMITS.tailor.limit;
    for (let i = 0; i < tailorLimit; i++) {
      recordUsage("user-1", "tailor", BASE);
    }

    expect(checkRateLimit("user-1", "tailor", BASE).allowed).toBe(false);
    // compile has its own budget and hasn't been touched
    expect(checkRateLimit("user-1", "compile", BASE).allowed).toBe(true);
  });

  it("gives independent budgets per user", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const limit = RATE_LIMITS.scrape.limit;
    for (let i = 0; i < limit; i++) {
      recordUsage("user-1", "scrape", BASE);
    }

    expect(checkRateLimit("user-1", "scrape", BASE).allowed).toBe(false);
    expect(checkRateLimit("user-2", "scrape", BASE).allowed).toBe(true);
  });

  it("checkRateLimit alone never consumes allowance", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    for (let i = 0; i < 5; i++) {
      checkRateLimit("user-1", "tailor", BASE);
    }

    const conn = getDb();
    const count = (conn.prepare("SELECT COUNT(*) n FROM usage_events").get() as { n: number }).n;
    expect(count).toBe(0);

    // repeated checks against an empty table report the full limit every time
    const result = checkRateLimit("user-1", "tailor", BASE);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMITS.tailor.limit);
  });

  it("retryAfterSeconds reflects when the oldest event in the window ages out", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const { limit, windowSeconds } = RATE_LIMITS.compile;
    for (let i = 0; i < limit; i++) {
      recordUsage("user-1", "compile", BASE);
    }

    const tenSecondsLater = new Date(BASE.getTime() + 10_000);
    const result = checkRateLimit("user-1", "compile", tenSecondsLater);
    expect(result.allowed).toBe(false);
    // the oldest event (at BASE) ages out at BASE + windowSeconds; checking 10s after BASE means
    // windowSeconds - 10 seconds remain
    expect(result.retryAfterSeconds).toBe(windowSeconds - 10);
  });

  it("prunes rows older than the longest window and keeps current ones", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    // this insert's own prune runs relative to itself, so the ancient row survives its own write
    const ancient = new Date("2020-01-01T00:00:00.000Z");
    recordUsage("user-1", "scrape", ancient);

    // this insert's prune runs relative to `recent`, whose cutoff (recent - longest window) is well
    // past 2020 -- the ancient row should be swept away here
    const recent = new Date("2026-06-01T00:00:00.000Z");
    recordUsage("user-1", "scrape", recent);

    const conn = getDb();
    const rows = conn.prepare("SELECT created_at FROM usage_events").all() as { created_at: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].created_at).toBe(recent.toISOString());
  });
});
