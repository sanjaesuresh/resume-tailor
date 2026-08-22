import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { getDb } from "./db";
import { redeemInvite, unredeemInvite, inviteErrorMessage } from "./invites";

// the shape requireUser hands back to callers, kept intentionally small -- routes that need more
// than this look it up themselves via the user id, rather than this module growing into a second
// place that knows about application rows, settings, etc.
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

// discriminated union, not a nullable AuthUser: a route that does `requireUser(...).user.id`
// without narrowing `ok` first does not compile, because `user` only exists on the true branch.
// That is the actual enforcement mechanism -- there is no "forgot to check" value to fall through on.
export type RequireUserResult = { ok: true; user: AuthUser } | { ok: false; response: Response };

// better-sqlite3 is a native module and cannot run in the edge runtime, so betterAuth() and its
// migrations are constructed lazily on first real use (a request hitting the auth route, or a test
// calling requireUser/getAuth) rather than at module import time. Importing this file must be safe
// from any context, including a vitest worker that never touches a real database.
let authInstance: ReturnType<typeof betterAuth> | null = null;
let authOptions: BetterAuthOptions | null = null;
let schemaEnsured: Promise<void> | null = null;

function buildAuth(): { auth: ReturnType<typeof betterAuth>; options: BetterAuthOptions } {
  // reuses lib/db.ts's singleton connection (same file, same handle) rather than opening a second
  // one, so the app never has two writers open against a database that isn't in WAL mode
  const db = getDb();

  const options: BetterAuthOptions = {
    database: db,
    emailAndPassword: {
      enabled: true,
      // no transactional email sender exists (see plan section 12) -- requiring verification would
      // make every signup a dead end, so this stays off until a mailer is added
      requireEmailVerification: false,
    },
    // BETTER_AUTH_SECRET signs session tokens; better-auth silently falls back to a well-known
    // placeholder secret if none is set, which would make every session forgeable. Failing loudly
    // here matches how lib/config.ts treats a missing/invalid LLM_PROVIDER.
    secret: requireAuthSecret(),
    baseURL: process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000",
    // cookie attributes are deliberately left at better-auth's defaults: httpOnly true, sameSite
    // "lax", and "secure" auto-follows NODE_ENV/https -- exactly what's wanted, and hardcoding
    // secure:true here would silently break session cookies over plain http in local dev.
    hooks: {
      // the ONLY gate for account creation. It runs for both HTTP requests through the catch-all
      // route AND direct auth.api.signUpEmail(...) calls from server code, so there is no path to
      // a new user that skips it -- this is what makes "invite-only" structural rather than a
      // convention every call site has to remember.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;

        const code = typeof ctx.body?.inviteCode === "string" ? ctx.body.inviteCode : "";
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";

        // redeeming here (before creation) rather than in the after-hook is what makes this
        // race-free under concurrent signups: the UPDATE inside redeemInvite is the single point
        // where "is this code still available" is decided, and it runs before any account exists.
        const result = redeemInvite(db, code, email);
        if (!result.ok) {
          throw new APIError("BAD_REQUEST", { message: inviteErrorMessage(result.reason) });
        }
      }),
      // compensates the redemption above if account creation itself failed for an unrelated reason
      // (duplicate email, password policy, etc) -- otherwise a user would burn their one invite on
      // an error that had nothing to do with the invite being valid.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;

        const returned = ctx.context.returned;
        const succeeded =
          !!returned && !(returned instanceof APIError) && typeof returned === "object" && "user" in returned;

        if (!succeeded) {
          const code = typeof ctx.body?.inviteCode === "string" ? ctx.body.inviteCode : "";
          if (code) unredeemInvite(db, code);
        }
      }),
    },
  };

  return { auth: betterAuth(options), options };
}

function getAuthBundle(): { auth: ReturnType<typeof betterAuth>; options: BetterAuthOptions } {
  if (!authInstance || !authOptions) {
    const built = buildAuth();
    authInstance = built.auth;
    authOptions = built.options;
  }
  return { auth: authInstance, options: authOptions };
}

function requireAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set -- generate one with `openssl rand -base64 32` and add it to .env.local"
    );
  }
  return secret;
}

// better-auth owns the user/session/account/verification tables and creates them itself (this app's
// hand-written migration runner in lib/migrate.ts only knows about its own tables). Checking for
// the "user" table first keeps this idempotent and cheap after the first call in a process's life.
async function ensureAuthSchema(): Promise<void> {
  if (!schemaEnsured) {
    schemaEnsured = (async () => {
      const { options } = getAuthBundle();
      const db = getDb();
      const hasUserTable = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'`)
        .get();
      if (!hasUserTable) {
        const { runMigrations } = await getMigrations(options);
        await runMigrations();
      }
    })();
  }
  return schemaEnsured;
}

/**
 * Returns the lazily-constructed Better Auth instance, ensuring its own tables exist first.
 * The auth route handler and requireUser are the only intended callers.
 */
export async function getAuth(): Promise<ReturnType<typeof betterAuth>> {
  await ensureAuthSchema();
  return getAuthBundle().auth;
}

/**
 * Resolves the signed-in user from a request's session cookie. Every route that touches a
 * user-owned resource must call this first and check `ok` before doing anything else -- see
 * RequireUserResult's doc comment for why that isn't just a convention here.
 */
export async function requireUser(request: Request): Promise<RequireUserResult> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session?.user) {
    return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  return {
    ok: true,
    user: { id: session.user.id, email: session.user.email, name: session.user.name ?? null },
  };
}
