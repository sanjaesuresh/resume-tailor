// Hands pre-auth, unowned applications to one existing account.
// Runtime-safe for the standalone Docker image:
//   node scripts/claim-orphans.mjs your@email
import Database from "better-sqlite3";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

function usage() {
  console.error("usage: node scripts/claim-orphans.mjs <your-account-email>");
}

function main() {
  const email = process.argv[2]?.trim();
  if (!email) {
    usage();
    process.exitCode = 1;
    return;
  }

  const db = new Database(path.join(DATA_DIR, "tracker.db"));

  try {
    const hasUserTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'")
      .get();
    if (!hasUserTable) {
      console.error("No auth accounts exist yet. Sign up first, then run this script.");
      process.exitCode = 1;
      return;
    }

    const user = db.prepare("SELECT id FROM user WHERE email = ?").get(email);
    if (!user) {
      console.error(`No account found for ${email}. Sign up first, then run this.`);
      process.exitCode = 1;
      return;
    }

    const claim = db.transaction(() => {
      const { n: accounts } = db.prepare("SELECT COUNT(*) n FROM user").get();
      if (accounts > 1) {
        throw new Error(
          `Refusing to claim: ${accounts} accounts exist, so there is no way to tell from the data ` +
            `which one these rows belong to. Assign them by hand.`
        );
      }

      return db
        .prepare("UPDATE applications SET user_id = @user_id WHERE user_id IS NULL")
        .run({ user_id: user.id }).changes;
    });

    const claimed = claim.immediate();
    console.log(
      claimed === 0
        ? "Nothing to claim -- every application already has an owner."
        : `Claimed ${claimed} application(s) for ${email}.`
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
