import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

function generateCode() {
  return crypto.randomBytes(18).toString("base64url");
}

function main() {
  const emailArg = process.argv[2]?.trim();
  const email = emailArg ? emailArg : null;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "tracker.db"));

  try {
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

    console.log(code);
  } finally {
    db.close();
  }
}

main();
