import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getDb,
  createApplication,
  listApplications,
  getApplication,
  updateApplication,
} from "../db";

// each test gets its own temp-file db path so tests never share state or clobber the real tracker.db;
// getDb(dbPath) re-points the module's memoized connection at that path for the duration of the test
function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-db-")), "tracker.db");
}

describe("db", () => {
  let dbDir: string;

  afterEach(() => {
    if (dbDir && fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("createApplication returns a row with an id and default status 'applied'", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const row = createApplication({
      company: "Acme",
      role: "Engineer",
      url: "https://acme.example/job/1",
      atsReport: { score: 90 },
      texPath: "/tmp/acme.tex",
      pdfPath: "/tmp/acme.pdf",
      appliedAt: "2026-01-01",
    });

    expect(row.id).toBeTypeOf("number");
    expect(row.status).toBe("applied");
    expect(row.company).toBe("Acme");
  });

  it("listApplications returns inserted rows newest-first", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    createApplication({ company: "First", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });
    createApplication({ company: "Second", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-02" });

    const rows = listApplications();
    expect(rows.length).toBe(2);
    expect(rows[0].company).toBe("Second");
    expect(rows[1].company).toBe("First");
  });

  it("updating status to 'interview' persists", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const created = createApplication({ company: "Acme", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });

    const updated = updateApplication(created.id, { status: "interview" });
    expect(updated.status).toBe("interview");

    const fetched = getApplication(created.id);
    expect(fetched?.status).toBe("interview");
  });

  it("updating status to an invalid string throws", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const created = createApplication({ company: "Acme", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });

    expect(() => updateApplication(created.id, { status: "bogus" as never })).toThrow();
  });

  it("updateApplication throws on unknown fields in patch", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const created = createApplication({ company: "Acme", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });

    // attempt to inject via an unknown column name (the latent injection surface)
    expect(() => updateApplication(created.id, { "id = 999; --": "evil" } as any)).toThrow();
  });

  it("ats_report round-trips as an object", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const report = { score: 87, missingSkills: ["Go", "Kubernetes"] };
    const created = createApplication({ company: "Acme", role: "Engineer", url: "", atsReport: report, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });

    expect(created.atsReport).toEqual(report);

    const fetched = getApplication(created.id);
    expect(fetched?.atsReport).toEqual(report);
  });
});
