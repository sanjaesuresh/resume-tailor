import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { DATA_DIR } from "./config";

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

  db = new Database(targetPath);
  currentPath = targetPath;

  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
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

  return db;
}

export function createApplication(input: CreateApplicationInput): Application {
  const conn = getDb();
  const stmt = conn.prepare(`
    INSERT INTO applications (company, role, url, ats_report, tex_path, pdf_path, applied_at)
    VALUES (@company, @role, @url, @ats_report, @tex_path, @pdf_path, @applied_at)
  `);

  const result = stmt.run({
    company: input.company,
    role: input.role,
    url: input.url ?? null,
    ats_report: input.atsReport !== undefined ? JSON.stringify(input.atsReport) : null,
    tex_path: input.texPath ?? null,
    pdf_path: input.pdfPath ?? null,
    applied_at: input.appliedAt ?? null,
  });

  return getApplication(Number(result.lastInsertRowid)) as Application;
}

export function listApplications(): Application[] {
  const conn = getDb();
  const rows = conn
    .prepare("SELECT * FROM applications ORDER BY id DESC")
    .all() as ApplicationRow[];
  return rows.map(rowToApplication);
}

export function getApplication(id: number): Application | null {
  const conn = getDb();
  const row = conn
    .prepare("SELECT * FROM applications WHERE id = ?")
    .get(id) as ApplicationRow | undefined;
  return row ? rowToApplication(row) : null;
}

export function updateApplication(id: number, patch: UpdateApplicationPatch): Application {
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
    const existing = getApplication(id);
    if (!existing) throw new Error(`Application ${id} not found`);
    return existing;
  }

  const setClause = fields.map((field) => `${field} = @${field}`).join(", ");
  conn.prepare(`UPDATE applications SET ${setClause} WHERE id = @id`).run({ ...patch, id });

  const updated = getApplication(id);
  if (!updated) throw new Error(`Application ${id} not found`);
  return updated;
}
