import fs from "fs";
import path from "path";
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

// the only place slug collisions are resolved: if `<applicationsDir>/<slug>` already exists on
// disk, append -2, -3, ... until a free directory name is found
function buildSlug(
  company: string,
  role: string,
  date: Date,
  applicationsDir: string
): string {
  const base = `${slugifyPart(company)}-${slugifyPart(role)}-${formatYyyymmdd(date)}`;
  let candidate = base;
  let suffix = 2;
  while (fs.existsSync(path.join(applicationsDir, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  return candidate;
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
export function persistApplication(input: PersistApplicationInput): Application {
  const dataDir = input.dataDir ?? DATA_DIR;
  const now = input.now ?? new Date();
  const applicationsDir = path.join(dataDir, "applications");
  fs.mkdirSync(applicationsDir, { recursive: true });

  const slug = buildSlug(input.company, input.role, now, applicationsDir);
  const appDir = path.join(applicationsDir, slug);
  // buildSlug only ever returns a candidate that didn't already exist on disk, so this call is
  // always the sole creator of appDir -- safe to remove it wholesale in the catch below.
  fs.mkdirSync(appDir, { recursive: true });

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

    return createApplication({
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
