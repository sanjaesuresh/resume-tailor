import type Database from "better-sqlite3";

// ordered, forward-only migration steps -- each "up" is plain DDL against the shared connection.
// no down migrations: rolling back a public service's schema is a restore-from-backup operation,
// not a code path worth maintaining.
interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    // reproduces exactly what lib/db.ts used to create inline via CREATE TABLE IF NOT EXISTS, so a
    // database that predates the migration runner and one that starts fresh converge on the same
    // schema. if the table already exists (the old single-user db), skip the DDL entirely -- it's
    // still recorded as applied below, which is what lets an existing db's real applications rows
    // survive untouched instead of being seen as "missing" a table it already has.
    version: 1,
    up: (db) => {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'applications'")
        .get();
      if (!exists) {
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
      }
    },
  },
  {
    // one row per user; tailor_prompt NULL is load-bearing ("use the built-in default"), not "empty"
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_settings (
          user_id TEXT PRIMARY KEY,
          display_name TEXT,
          base_resume_tex TEXT,
          skills_whitelist TEXT,
          tailor_prompt TEXT,
          updated_at TEXT
        )
      `);
    },
  },
  {
    // redemption logic (marking redeemed_at/redeemed_by) lives with the auth module, not here.
    // IF NOT EXISTS because scripts/create-invite.ts also creates this table so it can mint the
    // first code before the app has ever started -- without it, minting an invite and then booting
    // kills migration 3 on "table already exists".
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS invites (
          code TEXT PRIMARY KEY,
          email TEXT,
          created_at TEXT,
          redeemed_at TEXT,
          redeemed_by TEXT
        )
      `);
    },
  },
  {
    // backs the per-user rate limits; the index matches the (user, kind, window) lookup they need
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX idx_usage_events_user_kind_created ON usage_events (user_id, kind, created_at)`);
    },
  },
  {
    // nullable so existing single-user rows survive as unowned; lib/db.ts's claimOrphanApplications
    // assigns them later. index matches the ownership-scoped "list newest first" query.
    version: 5,
    up: (db) => {
      db.exec(`ALTER TABLE applications ADD COLUMN user_id TEXT`);
      db.exec(`CREATE INDEX idx_applications_user_id ON applications (user_id, id DESC)`);
    },
  },
];

// applies every migration not yet recorded in schema_migrations, each inside its own transaction so
// a failure partway through never leaves a version marked applied without its DDL having run.
// calling this twice against the same db is a no-op the second time.
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // BEGIN IMMEDIATE takes sqlite's write lock up front, so two processes starting at once cannot
  // both read an empty applied-set and then both try the same CREATE TABLE. Without it the second
  // one dies on "table already exists" -- reproducible, and it becomes a real risk the moment more
  // than one instance of the container runs. The version re-read inside the lock is what makes the
  // loser of that race a no-op rather than a failure.
  const migrate = db.transaction(() => {
    const applied = new Set(
      (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
        (row) => row.version
      )
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
    }
  });

  migrate.immediate();
}
