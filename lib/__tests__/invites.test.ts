import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { redeemInvite, unredeemInvite } from "../invites";

// redeemInvite/unredeemInvite take a raw better-sqlite3 connection, so these tests build their own
// minimal invites table matching the shape the migration owner (lib/migrate.ts) creates, rather
// than importing that file -- this keeps the two agents' work decoupled during parallel edits.
function tempDb(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-invites-"));
  const db = new Database(path.join(dir, "test.db"));
  db.exec(`
    CREATE TABLE invites (
      code TEXT PRIMARY KEY,
      email TEXT,
      created_at TEXT,
      redeemed_at TEXT,
      redeemed_by TEXT
    )
  `);
  return { db, dir };
}

function insertInvite(db: Database.Database, code: string, email: string | null = null): void {
  db.prepare(
    `INSERT INTO invites (code, email, created_at, redeemed_at, redeemed_by) VALUES (?, ?, ?, NULL, NULL)`
  ).run(code, email, new Date().toISOString());
}

describe("redeemInvite", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  it("succeeds for a valid, unredeemed code", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);
    insertInvite(db, "GOODCODE");

    const result = redeemInvite(db, "GOODCODE", "person@example.com");

    expect(result).toEqual({ ok: true });
    const row = db.prepare("SELECT redeemed_at, redeemed_by FROM invites WHERE code = ?").get("GOODCODE") as {
      redeemed_at: string | null;
      redeemed_by: string | null;
    };
    expect(row.redeemed_at).not.toBeNull();
    expect(row.redeemed_by).toBe("person@example.com");
  });

  it("fails for an unknown code", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);

    const result = redeemInvite(db, "NOSUCHCODE", "person@example.com");

    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("fails for an already-redeemed code", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);
    insertInvite(db, "ONCEONLY");

    const first = redeemInvite(db, "ONCEONLY", "first@example.com");
    const second = redeemInvite(db, "ONCEONLY", "second@example.com");

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: "already_redeemed" });
    // the first redeemer's record must survive the second, rejected attempt untouched
    const row = db.prepare("SELECT redeemed_by FROM invites WHERE code = ?").get("ONCEONLY") as {
      redeemed_by: string | null;
    };
    expect(row.redeemed_by).toBe("first@example.com");
  });

  it("fails for an absent or empty code", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);

    expect(redeemInvite(db, "", "person@example.com")).toEqual({ ok: false, reason: "missing_code" });
    expect(redeemInvite(db, "   ", "person@example.com")).toEqual({ ok: false, reason: "missing_code" });
  });

  it("is single-use under repeated attempts, including immediately re-trying the exact same call", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);
    insertInvite(db, "REPEATME");

    const attempts = [
      redeemInvite(db, "REPEATME", "person@example.com"),
      redeemInvite(db, "REPEATME", "person@example.com"),
      redeemInvite(db, "REPEATME", "person@example.com"),
    ];

    expect(attempts[0]).toEqual({ ok: true });
    expect(attempts[1]).toEqual({ ok: false, reason: "already_redeemed" });
    expect(attempts[2]).toEqual({ ok: false, reason: "already_redeemed" });
  });

  it("rejects a redemption whose email does not match the invite's issued email", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);
    insertInvite(db, "SCOPEDCODE", "issued-to@example.com");

    const wrongEmail = redeemInvite(db, "SCOPEDCODE", "someone-else@example.com");
    expect(wrongEmail).toEqual({ ok: false, reason: "email_mismatch" });

    // the matching email (case-insensitive) still succeeds
    const rightEmail = redeemInvite(db, "SCOPEDCODE", "Issued-To@example.com");
    expect(rightEmail).toEqual({ ok: true });
  });

  it("allows any email to redeem a code with no issued email", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);
    insertInvite(db, "OPENCODE", null);

    const result = redeemInvite(db, "OPENCODE", "anyone@example.com");
    expect(result).toEqual({ ok: true });
  });
});

describe("unredeemInvite", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  it("reverts a redemption so the code becomes available again", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);
    insertInvite(db, "COMPENSATE");

    expect(redeemInvite(db, "COMPENSATE", "person@example.com")).toEqual({ ok: true });

    unredeemInvite(db, "COMPENSATE");

    const row = db.prepare("SELECT redeemed_at, redeemed_by FROM invites WHERE code = ?").get(
      "COMPENSATE"
    ) as { redeemed_at: string | null; redeemed_by: string | null };
    expect(row.redeemed_at).toBeNull();
    expect(row.redeemed_by).toBeNull();

    // and it can now be redeemed again, exactly as if the failed attempt never happened
    expect(redeemInvite(db, "COMPENSATE", "second-try@example.com")).toEqual({ ok: true });
  });

  it("is a harmless no-op for an unknown code", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);

    expect(() => unredeemInvite(db, "NEVERSEEN")).not.toThrow();
  });
});
