import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

// how far the same company/role/date slug will be walked before falling back to a random suffix
const MAX_SLUG_ATTEMPTS = 100;
import { DATA_DIR } from "./config";
import { createApplication, getDb, type Application } from "./db";

// lowercase, collapse any run of non-alphanumerics to a single hyphen, and trim leading/trailing
// hyphens -- keeps slugs filesystem- and URL-safe regardless of what the user typed as company/role
function slugifyPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// local (not UTC) date components -- matches what a person reading "applied on" would expect,
// and keeps the fixed-date tests independent of the machine's timezone
function formatYyyymmdd(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// the only place slug collisions are resolved. Directory creation IS the claim: each candidate is
// claimed with a non-recursive mkdirSync inside the loop, and EEXIST (another call already holds
// that slug) advances to the next suffix -- this closes the TOCTOU window a separate
// existsSync-then-mkdirSync pair would leave open between two concurrent callers targeting the
// same company/role/date. Returns the directory this call actually created, so the caller can
// safely remove exactly that directory (and only that one) on a later failure.
function claimSlugDir(
  company: string,
  role: string,
  date: Date,
  applicationsDir: string
): { slug: string; appDir: string } {
  const base = `${slugifyPart(company)}-${slugifyPart(role)}-${formatYyyymmdd(date)}`;
  let candidate = base;

  // the linear scan is O(n) in same-day duplicates for the same company and role, so the Nth save
  // costs N mkdir syscalls. Capped rather than left unbounded: past this many the sequence is not
  // a person applying repeatedly, and walking it forever is a cheap way to burn inodes.
  for (let suffix = 2; suffix <= MAX_SLUG_ATTEMPTS; suffix++) {
    const appDir = path.join(applicationsDir, candidate);
    try {
      fs.mkdirSync(appDir, { recursive: false });
      return { slug: candidate, appDir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      candidate = `${base}-${suffix}`;
    }
  }

  // one random suffix beats both failing outright and scanning further -- a collision here would
  // need the same company, role and day plus a 2^48 coincidence
  const appDir = path.join(applicationsDir, `${base}-${randomBytes(6).toString("hex")}`);
  fs.mkdirSync(appDir, { recursive: false });
  return { slug: path.basename(appDir), appDir };
}

export interface PersistApplicationInput {
  tex: string;
  pdf: Buffer;
  company: string;
  role: string;
  url?: string;
  report: unknown;
  dataDir?: string; // override DATA_DIR (tests only) so nothing ever writes into the real data/ dir
  now?: Date; // override "today" for slug/appliedAt (tests only)
}

// better-auth ids are random alphanumerics, so this always passes today. It is asserted anyway
// because the value is about to be interpolated into a filesystem path: the day someone passes an
// id taken from a request body instead of session.user.id, "../.." would escape the data directory.
const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;

// shared guard for the approve route's "report" field: must be a non-null, non-array object.
// exported (rather than kept private) so it's directly unit-testable without importing the route
// module, whose "@/" aliased imports don't resolve under this repo's vitest setup.
export function isValidReport(report: unknown): report is Record<string, unknown> {
  return typeof report === "object" && report !== null && !Array.isArray(report);
}

/**
 * Writes a compiled resume + its ATS report to disk under a per-application slug directory,
 * and inserts the corresponding tracker row. The slug directory is the single source of truth
 * for where a given application's files live; the DB row just points at it.
 */
export function persistApplication(userId: string, input: PersistApplicationInput): Application {
  if (!SAFE_USER_ID.test(userId)) {
    throw new Error("Invalid user id");
  }

  const dataDir = input.dataDir ?? DATA_DIR;
  const now = input.now ?? new Date();
  // namespaced per user: without it, the "-2" collision suffix claimSlugDir appends would tell one
  // user that somebody else applied to the same company and role on the same day
  const applicationsDir = path.join(dataDir, "applications", userId);
  fs.mkdirSync(applicationsDir, { recursive: true });

  // claimSlugDir's mkdirSync succeeding IS the claim: this call is guaranteed to be the sole
  // creator of appDir (a concurrent caller racing for the same slug gets EEXIST and moves on to
  // the next suffix instead), so it's safe to remove appDir wholesale in the catch below without
  // risking another application's already-persisted files.
  const { appDir } = claimSlugDir(input.company, input.role, now, applicationsDir);

  try {
    const texPath = path.join(appDir, "resume.tex");
    const pdfPath = path.join(appDir, "resume.pdf");
    const reportPath = path.join(appDir, "report.json");

    // fall back to null so a nullish report never reaches JSON.stringify(undefined), which
    // returns the JS value `undefined` and makes writeFileSync throw
    const report = input.report ?? null;

    fs.writeFileSync(texPath, input.tex, "utf-8");
    fs.writeFileSync(pdfPath, input.pdf);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

    // point the db module's memoized connection at the right file before inserting -- real callers
    // get DATA_DIR/tracker.db; tests get the temp dataDir's tracker.db, never the real one
    getDb(path.join(dataDir, "tracker.db"));

    return createApplication(userId, {
      company: input.company,
      role: input.role,
      url: input.url,
      atsReport: report,
      texPath,
      pdfPath,
      appliedAt: now.toISOString(),
    });
  } catch (err) {
    // any failure past this point (a bad report that can't serialize, an unwritable path, a
    // failing db insert) must not leave an orphaned slug directory with files but no tracker row
    fs.rmSync(appDir, { recursive: true, force: true });
    throw err;
  }
}
