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
  claimOrphanApplications,
  deleteApplication,
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

    const row = createApplication("user-1", {
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

    createApplication("user-1", { company: "First", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });
    createApplication("user-1", { company: "Second", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-02" });

    const rows = listApplications("user-1");
    expect(rows.length).toBe(2);
    expect(rows[0].company).toBe("Second");
    expect(rows[1].company).toBe("First");
  });

  it("updating status to 'interview' persists", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const created = createApplication("user-1", { company: "Acme", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });

    const updated = updateApplication(created.id, "user-1", { status: "interview" });
    expect(updated.status).toBe("interview");

    const fetched = getApplication(created.id, "user-1");
    expect(fetched?.status).toBe("interview");
  });

  it("updating status to an invalid string throws", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const created = createApplication("user-1", { company: "Acme", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });

    expect(() => updateApplication(created.id, "user-1", { status: "bogus" as never })).toThrow();
  });

  it("updateApplication throws on unknown fields in patch", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const created = createApplication("user-1", { company: "Acme", role: "Engineer", url: "", atsReport: {}, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });

    // attempt to inject via an unknown column name (the latent injection surface)
    expect(() => updateApplication(created.id, "user-1", { "id = 999; --": "evil" } as unknown as never)).toThrow();
  });

  it("ats_report round-trips as an object", () => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);

    const report = { score: 87, missingSkills: ["Go", "Kubernetes"] };
    const created = createApplication("user-1", { company: "Acme", role: "Engineer", url: "", atsReport: report, texPath: "", pdfPath: "", appliedAt: "2026-01-01" });

    expect(created.atsReport).toEqual(report);

    const fetched = getApplication(created.id, "user-1");
    expect(fetched?.atsReport).toEqual(report);
  });

  describe("ownership scoping", () => {
    it("listApplications only returns the calling user's rows", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      createApplication("user-1", { company: "Mine", role: "Engineer" });
      createApplication("user-2", { company: "Theirs", role: "Engineer" });

      const rows = listApplications("user-1");
      expect(rows.map((r) => r.company)).toEqual(["Mine"]);
    });

    it("getApplication returns null for another user's row, indistinguishable from not-found", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      const created = createApplication("user-1", { company: "Mine", role: "Engineer" });

      expect(getApplication(created.id, "user-2")).toBeNull();
      expect(getApplication(999999, "user-2")).toBeNull();
    });

    it("updateApplication cannot mutate another user's row", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      const created = createApplication("user-1", { company: "Mine", role: "Engineer" });

      expect(() => updateApplication(created.id, "user-2", { status: "interview" })).toThrow();

      // the row itself is untouched by the rejected cross-user update
      const fetched = getApplication(created.id, "user-1");
      expect(fetched?.status).toBe("applied");
    });
  });

  describe("deleteApplication", () => {
    it("deletes the caller's own row and hands it back for file cleanup", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      const created = createApplication("user-1", {
        company: "Acme",
        role: "Engineer",
        texPath: "/tmp/x/resume.tex",
      });

      const deleted = deleteApplication(created.id, "user-1");

      // the row comes back so the caller knows which files to remove -- it is gone from the db
      expect(deleted?.id).toBe(created.id);
      expect(deleted?.texPath).toBe("/tmp/x/resume.tex");
      expect(getApplication(created.id, "user-1")).toBeNull();
      expect(listApplications("user-1")).toEqual([]);
    });

    it("refuses to delete another user's row, and leaves it intact", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      const created = createApplication("user-1", { company: "Acme", role: "Engineer" });

      expect(deleteApplication(created.id, "user-2")).toBeNull();
      // still there for its actual owner -- a failed cross-user delete must not be destructive
      expect(getApplication(created.id, "user-1")?.company).toBe("Acme");
    });

    it("answers a missing row and someone else's row identically", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);
      const created = createApplication("user-1", { company: "Acme", role: "Engineer" });

      // ids are sequential, so a distinguishable answer would confirm which ones exist
      expect(deleteApplication(created.id, "user-2")).toBeNull();
      expect(deleteApplication(999_999, "user-2")).toBeNull();
    });

    it("leaves the caller's other applications alone", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      const first = createApplication("user-1", { company: "Acme", role: "Engineer" });
      createApplication("user-1", { company: "Globex", role: "Engineer" });

      deleteApplication(first.id, "user-1");

      expect(listApplications("user-1").map((a) => a.company)).toEqual(["Globex"]);
    });
  });

  describe("claimOrphanApplications", () => {
    it("assigns only rows with no owner, and leaves owned rows alone", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      const conn = getDb(dbPath);

      // simulate pre-existing single-user rows: inserted with no user_id at all
      conn
        .prepare("INSERT INTO applications (company, role) VALUES (?, ?)")
        .run("Orphan One", "Engineer");
      conn
        .prepare("INSERT INTO applications (company, role) VALUES (?, ?)")
        .run("Orphan Two", "Engineer");
      const owned = createApplication("user-2", { company: "Already Owned", role: "Engineer" });

      const claimed = claimOrphanApplications("user-1");
      expect(claimed).toBe(2);

      expect(listApplications("user-1").map((r) => r.company).sort()).toEqual([
        "Orphan One",
        "Orphan Two",
      ]);
      // the already-owned row still belongs to user-2, not reassigned
      expect(getApplication(owned.id, "user-2")).not.toBeNull();
      expect(getApplication(owned.id, "user-1")).toBeNull();
    });

    it("is a no-op when there are no unowned rows", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      createApplication("user-1", { company: "Mine", role: "Engineer" });

      expect(claimOrphanApplications("user-2")).toBe(0);
      expect(listApplications("user-2")).toEqual([]);
    });

    it("refuses to claim once a second account exists, and changes nothing", () => {
      // the orphans are the deployer's own pre-existing applications. On an invite-only service,
      // letting whoever calls this first take them means handing a stranger the owner's job search
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      const conn = getDb(dbPath);

      // better-auth owns this table and creates it lazily, so stand in the minimum this guard reads
      conn.exec(`CREATE TABLE user (id TEXT PRIMARY KEY)`);
      conn.prepare("INSERT INTO user (id) VALUES (?)").run("user-1");
      conn.prepare("INSERT INTO user (id) VALUES (?)").run("user-2");

      conn
        .prepare("INSERT INTO applications (company, role) VALUES (?, ?)")
        .run("Orphan One", "Engineer");

      expect(() => claimOrphanApplications("user-2")).toThrow(/2 accounts exist/);

      // the refusal must leave the row unowned rather than half-claiming it
      const stillUnowned = conn
        .prepare("SELECT COUNT(*) n FROM applications WHERE user_id IS NULL")
        .get() as { n: number };
      expect(stillUnowned.n).toBe(1);
      expect(listApplications("user-2")).toEqual([]);
    });

    it("still works when the auth tables do not exist yet", () => {
      // claiming can legitimately happen on a database where nobody has signed up through
      // better-auth yet, so an absent "user" table must read as zero accounts, not crash
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      const conn = getDb(dbPath);

      conn
        .prepare("INSERT INTO applications (company, role) VALUES (?, ?)")
        .run("Orphan One", "Engineer");

      expect(claimOrphanApplications("user-1")).toBe(1);
    });
  });
});
