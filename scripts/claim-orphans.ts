// Hands the pre-existing single-user applications to your account, once, after you sign up.
// Run from the project root:
//   node scripts/claim-orphans.ts your@email
//
// Deliberately a script and not a route. The rows it assigns are whatever was in the tracker
// before accounts existed -- on this install, the owner's own job applications -- so the decision
// of who gets them should be a person typing a command, not an HTTP request anyone could send.
//
// Same standalone-connection shape as create-invite.ts, and for the same reason documented there:
// plain `node` running a .ts file needs explicit extensions on relative imports, while tsconfig's
// "bundler" moduleResolution rejects them, so this cannot import lib/db.ts. lib/db.ts's
// claimOrphanApplications remains the canonical implementation and is the one under test; the
// guard below is kept deliberately identical to it -- if you change one, change both.
import Database from "better-sqlite3";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

const email = process.argv[2];
if (!email) {
  console.error("usage: node scripts/claim-orphans.ts <your-account-email>");
  process.exit(1);
}

const db = new Database(path.join(DATA_DIR, "tracker.db"));

try {
  const user = db.prepare("SELECT id FROM user WHERE email = ?").get(email) as
    | { id: string }
    | undefined;
  if (!user) {
    console.error(`No account found for ${email}. Sign up first, then run this.`);
    process.exit(1);
  }

  // one transaction so the account count cannot change between the check and the update
  const claim = db.transaction(() => {
    const { n: accounts } = db.prepare("SELECT COUNT(*) n FROM user").get() as { n: number };
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
  process.exit(1);
} finally {
  db.close();
}
