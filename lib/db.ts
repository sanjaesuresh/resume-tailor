import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "./config";
import { runMigrations } from "./migrate";

// statuses the tracker recognizes; anything else is rejected in updateApplication
const VALID_STATUSES = ["applied", "oa", "interview", "offer", "rejected"] as const;
type Status = (typeof VALID_STATUSES)[number];

// raw row shape as stored in sqlite (ats_report is a JSON string on disk)
interface ApplicationRow {
  id: number;
  company: string;
  role: string;
  url: string | null;
  status: string;
  notes: string;
  ats_report: string | null;
  tex_path: string | null;
  pdf_path: string | null;
  applied_at: string | null;
  created_at: string;
  user_id: string | null;
}

// public shape returned to callers, with ats_report parsed back into an object
export interface Application {
  id: number;
  company: string;
  role: string;
  url: string | null;
  status: string;
  notes: string;
  atsReport: unknown;
  texPath: string | null;
  pdfPath: string | null;
  appliedAt: string | null;
  createdAt: string;
}

// what a route is allowed to send back over the wire: Application minus the two absolute
// filesystem paths. Those are an internal detail -- the client builds every download URL from the
// id alone (app/page.tsx) and only ever used the paths as a "does this file exist" flag, which
// hasPdf/hasTex now carry explicitly.
export interface PublicApplication extends Omit<Application, "texPath" | "pdfPath"> {
  hasPdf: boolean;
  hasTex: boolean;
}

/**
 * Strips the stored paths before an application leaves the process. Serving them disclosed the
 * server's directory layout and the OS username, and once artifacts are namespaced per user the
 * path contains the owner's id -- plus the "-2" collision suffix from persist.ts would tell one
 * user that another applied to the same company and role on the same day.
 */
export function toPublicApplication(application: Application): PublicApplication {
  const { texPath, pdfPath, ...rest } = application;
  return { ...rest, hasPdf: pdfPath !== null, hasTex: texPath !== null };
}

export interface CreateApplicationInput {
  company: string;
  role: string;
  url?: string;
  atsReport?: unknown;
  texPath?: string;
  pdfPath?: string;
  appliedAt?: string;
}

export interface UpdateApplicationPatch {
  status?: string;
  notes?: string;
  company?: string;
  role?: string;
}

// module-level singleton so all callers within a process share one open connection;
// getDb(dbPath) re-points it at a new path (used by tests to isolate against temp files)
let db: Database.Database | null = null;
let currentPath: string | null = null;

function rowToApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    company: row.company,
    role: row.role,
    url: row.url,
    status: row.status,
    notes: row.notes,
    // ats_report is stored as a JSON string; null/empty means "no report yet"
    atsReport: row.ats_report ? JSON.parse(row.ats_report) : null,
    texPath: row.tex_path,
    pdfPath: row.pdf_path,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
  };
}

export function getDb(dbPath?: string): Database.Database {
  const targetPath = dbPath ?? currentPath ?? path.join(DATA_DIR, "tracker.db");

  // reuse the existing connection unless the caller asked for a different path
  if (db && targetPath === currentPath) {
    return db;
  }

  // switching paths (e.g. between test cases): close the old connection first
  if (db) {
    db.close();
    db = null;
  }

  // ensure the containing directory exists before sqlite tries to create the file
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // opened into a local, and only published to the module-level cache once it is fully migrated.
  // Caching it first was silently unrecoverable: a migration that threw left `db` pointing at a
  // half-migrated connection that every later call returned from the fast path above without
  // retrying, so one request saw the real error and every request after it saw "no such column"
  // until the process restarted.
  const opened = new Database(targetPath);

  try {
    // WAL lets readers (e.g. the files route streaming a pdf) proceed without blocking on a writer;
    // foreign_keys is off by default in sqlite and has to be turned on per-connection, not once in the schema
    opened.pragma("journal_mode = WAL");
    opened.pragma("foreign_keys = ON");
    runMigrations(opened);
  } catch (err) {
    // leave the cache empty so the next call retries from scratch rather than inheriting a
    // connection whose schema is in an unknown state
    opened.close();
    throw err;
  }

  db = opened;
  currentPath = targetPath;
  return db;
}

// userId is a required positional arg (not part of CreateApplicationInput) so a caller cannot
// construct a valid input object without one -- omitting it is a compile error, not a runtime bug
export function createApplication(userId: string, input: CreateApplicationInput): Application {
  const conn = getDb();
  const stmt = conn.prepare(`
    INSERT INTO applications (user_id, company, role, url, ats_report, tex_path, pdf_path, applied_at)
    VALUES (@user_id, @company, @role, @url, @ats_report, @tex_path, @pdf_path, @applied_at)
  `);

  const result = stmt.run({
    user_id: userId,
    company: input.company,
    role: input.role,
    url: input.url ?? null,
    ats_report: input.atsReport !== undefined ? JSON.stringify(input.atsReport) : null,
    tex_path: input.texPath ?? null,
    pdf_path: input.pdfPath ?? null,
    applied_at: input.appliedAt ?? null,
  });

  return getApplication(Number(result.lastInsertRowid), userId) as Application;
}

export function listApplications(userId: string): Application[] {
  const conn = getDb();
  const rows = conn
    .prepare("SELECT * FROM applications WHERE user_id = ? ORDER BY id DESC")
    .all(userId) as ApplicationRow[];
  return rows.map(rowToApplication);
}

// scoping the WHERE to user_id means a row owned by someone else comes back as undefined, same as a
// row that doesn't exist at all -- callers can't tell "not yours" from "not found", which is the point
export function getApplication(id: number, userId: string): Application | null {
  const conn = getDb();
  const row = conn
    .prepare("SELECT * FROM applications WHERE id = ? AND user_id = ?")
    .get(id, userId) as ApplicationRow | undefined;
  return row ? rowToApplication(row) : null;
}

export function updateApplication(
  id: number,
  userId: string,
  patch: UpdateApplicationPatch
): Application {
  if (patch.status !== undefined && !VALID_STATUSES.includes(patch.status as Status)) {
    throw new Error(
      `Invalid status "${patch.status}". Must be one of: ${VALID_STATUSES.join(", ")}`
    );
  }

  const conn = getDb();
  const allowedFields = ['status', 'notes', 'company', 'role'] as const;
  const fields = Object.keys(patch) as (keyof UpdateApplicationPatch)[];

  // validate that only allowed columns are in the patch; this prevents SQL injection through column names
  for (const field of fields) {
    if (!allowedFields.includes(field as typeof allowedFields[number])) {
      throw new Error(`Unknown field "${field}". Allowed fields: ${allowedFields.join(", ")}`);
    }
  }

  if (fields.length === 0) {
    const existing = getApplication(id, userId);
    if (!existing) throw new Error(`Application ${id} not found`);
    return existing;
  }

  // the user_id guard on the WHERE clause is what actually stops this from mutating someone else's
  // row -- without it, a valid id alone would be enough regardless of who's asking
  const setClause = fields.map((field) => `${field} = @${field}`).join(", ");
  conn
    .prepare(`UPDATE applications SET ${setClause} WHERE id = @id AND user_id = @user_id`)
    .run({ ...patch, id, user_id: userId });

  const updated = getApplication(id, userId);
  if (!updated) throw new Error(`Application ${id} not found`);
  return updated;
}

function countAccounts(conn: Database.Database): number {
  const table = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'")
    .get();
  if (!table) return 0;
  return (conn.prepare("SELECT COUNT(*) n FROM user").get() as { n: number }).n;
}

/**
 * One-time migration helper for plan 5.7: hands every currently-unowned row to userId.
 *
 * The `user_id IS NULL` clause already means an owned row can never be reassigned. The account
 * count is the other half, and it is not paranoia: the orphans are the deployer's own pre-existing
 * applications, so without it whichever account calls this first takes them -- and on an
 * invite-only service that is a stranger reading the owner's job search. Refusing outright when a
 * second account exists is correct, because at that point there is no longer any way to tell from
 * the data alone whose rows these were.
 *
 * Both statements run in one transaction so the count cannot go stale between the check and the
 * update. Not called from any route -- run it deliberately, once.
 */
export function claimOrphanApplications(userId: string): number {
  const conn = getDb();

  return conn.transaction(() => {
    // better-auth owns the "user" table and creates it lazily on the first auth request, outside
    // this module's migration runner -- so on a database where nobody has signed up yet it simply
    // does not exist. Absent table means zero accounts; querying it blindly throws instead.
    const accounts = countAccounts(conn);
    if (accounts > 1) {
      throw new Error(
        `Refusing to claim unowned applications: ${accounts} accounts exist, so there is no way ` +
          `to tell which one these rows belong to. Assign them by hand.`
      );
    }

    const result = conn
      .prepare("UPDATE applications SET user_id = @user_id WHERE user_id IS NULL")
      .run({ user_id: userId });
    return result.changes;
  }).immediate();
}
