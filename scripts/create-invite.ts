// mints a single-use invite code and prints it to stdout. Run from the project root, e.g.:
//   node scripts/create-invite.ts [email]
//
// Not wired through lib/db.ts, lib/migrate.ts, or lib/config.ts on purpose: this repo's other
// modules use the bundler-style extensionless imports Next/vitest resolve, but plain `node`
// running a .ts file directly needs an explicit extension on relative imports -- and tsc's
// "bundler" moduleResolution (see tsconfig.json) rejects an explicit ".ts" extension in return.
// Those two requirements can't both be satisfied by importing across files here, so DATA_DIR's
// definition (process.cwd()/"data") is duplicated rather than imported. This script opens its own
// short-lived connection to the same database file -- a one-off CLI process, so there's no
// write-contention concern in not sharing lib/db.ts's connection.
import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

// an invite code is a single-use bearer token, not a password or session credential -- a CSPRNG
// with enough bytes is exactly as strong as anything a hashing library would add here
function generateCode(): string {
  return crypto.randomBytes(18).toString("base64url");
}

function main(): void {
  const emailArg = process.argv[2]?.trim();
  const email = emailArg ? emailArg : null;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "tracker.db"));

  try {
    // mirrors the exact shape lib/migrate.ts creates for this table -- IF NOT EXISTS makes this a
    // no-op once that migration has run, and lets the script also work standalone before it has
    db.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        email TEXT,
        created_at TEXT,
        redeemed_at TEXT,
        redeemed_by TEXT
      )
    `);

    const code = generateCode();
    db.prepare(
      `INSERT INTO invites (code, email, created_at, redeemed_at, redeemed_by) VALUES (?, ?, ?, NULL, NULL)`
    ).run(code, email, new Date().toISOString());

    // stdout only, no other output -- this is the one thing the owner needs to copy or pipe onward
    console.log(code);
  } finally {
    db.close();
  }
}

main();
