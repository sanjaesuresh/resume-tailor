import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { runMigrations } from "../migrate";

// runMigrations takes a raw better-sqlite3 connection, not getDb(), so these tests exercise the
// runner directly and never touch the module-level singleton in lib/db.ts
function tempDb(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-migrate-"));
  const db = new Database(path.join(dir, "test.db"));
  return { db, dir };
}

describe("runMigrations", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  it("applies the full schema to an empty database", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);

    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "applications",
        "user_settings",
        "invites",
        "usage_events",
      ])
    );

    const columns = db
      .prepare("PRAGMA table_info(applications)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain("user_id");
  });

  it("adds the owner column to an existing single-user schema without touching its rows", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);

    // reproduces the pre-migration lib/db.ts schema exactly, with real-looking (but fake) rows,
    // as if this were an existing tracker.db that predates the migration runner
    db.exec(`
      CREATE TABLE applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        role TEXT NOT NULL,
        url TEXT,
        status TEXT NOT NULL DEFAULT 'applied',
        notes TEXT DEFAULT '',
        ats_report TEXT,
        tex_path TEXT,
        pdf_path TEXT,
        applied_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.prepare("INSERT INTO applications (company, role, status) VALUES (?, ?, ?)").run(
      "Existing Co",
      "Existing Role",
      "applied"
    );

    runMigrations(db);

    const rows = db.prepare("SELECT * FROM applications").all() as {
      company: string;
      role: string;
      user_id: string | null;
    }[];

    expect(rows.length).toBe(1);
    expect(rows[0].company).toBe("Existing Co");
    expect(rows[0].role).toBe("Existing Role");
    // the pre-existing row survives with no owner -- claimOrphanApplications assigns it later
    expect(rows[0].user_id).toBeNull();
  });

  it("running twice is a no-op", () => {
    const { db, dir } = tempDb();
    dirs.push(dir);

    runMigrations(db);
    const versionsAfterFirst = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();

    // a second run must not re-run any migration (e.g. a duplicate ALTER TABLE ADD COLUMN would throw)
    expect(() => runMigrations(db)).not.toThrow();

    const versionsAfterSecond = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();
    expect(versionsAfterSecond).toEqual(versionsAfterFirst);
  });
});
