import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { persistApplication, isValidReport } from "../persist";

// each test gets its own temp data dir so persisted files/db never touch the real data/ directory
function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-persist-"));
}

// fixed local date (not UTC) so it matches persistApplication's local getFullYear/getMonth/getDate
// components regardless of the machine's timezone
const FIXED_DATE = new Date(2026, 0, 15);

describe("persistApplication", () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("builds a slug from company-role-yyyymmdd, lowercased with non-alphanumerics collapsed to hyphens", () => {
    dataDir = tempDataDir();

    const application = persistApplication({
      tex: "\\documentclass{article}",
      pdf: Buffer.from("%PDF-fake"),
      company: "Stripe",
      role: "Software Engineer",
      url: "https://stripe.com/jobs/1",
      report: { scoreBefore: 10, scoreAfter: 90 },
      dataDir,
      now: FIXED_DATE,
    });

    const expectedSlug = "stripe-software-engineer-20260115";
    expect(application.texPath).toBe(
      path.join(dataDir, "applications", expectedSlug, "resume.tex")
    );
    expect(application.pdfPath).toBe(
      path.join(dataDir, "applications", expectedSlug, "resume.pdf")
    );
  });

  it("appends -2 on a slug collision (same company/role/date persisted twice)", () => {
    dataDir = tempDataDir();

    const first = persistApplication({
      tex: "\\documentclass{article}",
      pdf: Buffer.from("%PDF-fake-1"),
      company: "Stripe",
      role: "Software Engineer",
      url: "",
      report: {},
      dataDir,
      now: FIXED_DATE,
    });

    const second = persistApplication({
      tex: "\\documentclass{article}",
      pdf: Buffer.from("%PDF-fake-2"),
      company: "Stripe",
      role: "Software Engineer",
      url: "",
      report: {},
      dataDir,
      now: FIXED_DATE,
    });

    expect(path.basename(path.dirname(first.texPath!))).toBe(
      "stripe-software-engineer-20260115"
    );
    expect(path.basename(path.dirname(second.texPath!))).toBe(
      "stripe-software-engineer-20260115-2"
    );
  });

  it("writes resume.tex, resume.pdf, and report.json to the expected paths with the given contents", () => {
    dataDir = tempDataDir();

    const tex = "\\documentclass{article}\\begin{document}hi\\end{document}";
    const pdf = Buffer.from("%PDF-1.5 fake bytes");
    const report = { scoreBefore: 20, scoreAfter: 80, missing: ["kubernetes"] };

    const application = persistApplication({
      tex,
      pdf,
      company: "Acme Corp",
      role: "Backend Engineer",
      url: "https://acme.example/job/2",
      report,
      dataDir,
      now: FIXED_DATE,
    });

    const appDir = path.join(dataDir, "applications", "acme-corp-backend-engineer-20260115");
    expect(fs.readFileSync(path.join(appDir, "resume.tex"), "utf-8")).toBe(tex);
    expect(fs.readFileSync(path.join(appDir, "resume.pdf"))).toEqual(pdf);
    expect(JSON.parse(fs.readFileSync(path.join(appDir, "report.json"), "utf-8"))).toEqual(report);

    expect(application.texPath).toBe(path.join(appDir, "resume.tex"));
    expect(application.pdfPath).toBe(path.join(appDir, "resume.pdf"));
  });

  it("inserts a tracker row with the parsed report and default status 'applied'", () => {
    dataDir = tempDataDir();

    const report = { scoreBefore: 15, scoreAfter: 75, missing: ["go"] };

    const application = persistApplication({
      tex: "\\documentclass{article}",
      pdf: Buffer.from("%PDF-fake"),
      company: "Acme",
      role: "Engineer",
      url: "https://acme.example/job/3",
      report,
      dataDir,
      now: FIXED_DATE,
    });

    expect(application.id).toBeTypeOf("number");
    expect(application.company).toBe("Acme");
    expect(application.role).toBe("Engineer");
    expect(application.status).toBe("applied");
    expect(application.atsReport).toEqual(report);
  });

  it("lowercases and collapses punctuation in company/role into a single-hyphen slug with no leading/trailing hyphens", () => {
    dataDir = tempDataDir();

    const application = persistApplication({
      tex: "\\documentclass{article}",
      pdf: Buffer.from("%PDF-fake"),
      company: "AT&T",
      role: "Trader Joe's Engineer",
      report: {},
      dataDir,
      now: FIXED_DATE,
    });

    // "AT&T" -> "at-t" (the & collapses to a single hyphen, no leading/trailing hyphen from
    // the punctuation at the boundary); "Trader Joe's Engineer" -> "trader-joe-s-engineer"
    const expectedSlug = "at-t-trader-joe-s-engineer-20260115";
    expect(path.basename(path.dirname(application.texPath!))).toBe(expectedSlug);
  });

  it("does not leave an orphaned slug directory or files when report is nullish -- defaults to null instead of throwing", () => {
    dataDir = tempDataDir();

    const application = persistApplication({
      tex: "\\documentclass{article}",
      pdf: Buffer.from("%PDF-fake"),
      company: "Acme",
      role: "Engineer",
      report: undefined,
      dataDir,
      now: FIXED_DATE,
    });

    expect(application.atsReport).toBeNull();
    const appDir = path.join(dataDir, "applications", "acme-engineer-20260115");
    expect(
      JSON.parse(fs.readFileSync(path.join(appDir, "report.json"), "utf-8"))
    ).toBeNull();
  });

  it("removes the slug directory (rather than leaving orphaned tex/pdf files with no row) if the report fails to serialize mid-write", () => {
    dataDir = tempDataDir();

    // a circular reference makes JSON.stringify throw *after* resume.tex/resume.pdf have
    // already been written to appDir -- the exact "half-populated slug dir" failure mode
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      persistApplication({
        tex: "\\documentclass{article}",
        pdf: Buffer.from("%PDF-fake"),
        company: "Acme",
        role: "Engineer",
        report: circular,
        dataDir,
        now: FIXED_DATE,
      })
    ).toThrow();

    const applicationsDir = path.join(dataDir, "applications");
    expect(fs.existsSync(applicationsDir) ? fs.readdirSync(applicationsDir) : []).toEqual([]);
  });

  it("removes the slug directory if the db insert fails after files are already written (simulated unwritable db path)", () => {
    dataDir = tempDataDir();

    // pre-create tracker.db as a directory so better-sqlite3 throws "unable to open database
    // file" inside getDb -- simulates a persistence failure that happens after tex/pdf/report
    // are already on disk, so no partial row (and no orphaned files) should remain
    fs.mkdirSync(path.join(dataDir, "tracker.db"), { recursive: true });

    expect(() =>
      persistApplication({
        tex: "\\documentclass{article}",
        pdf: Buffer.from("%PDF-fake"),
        company: "Acme",
        role: "Engineer",
        report: {},
        dataDir,
        now: FIXED_DATE,
      })
    ).toThrow();

    const applicationsDir = path.join(dataDir, "applications");
    expect(fs.readdirSync(applicationsDir)).toEqual([]);
  });
});

describe("isValidReport", () => {
  // the approve route's stand-in for a "missing report" 422: since app/api/approve/route.ts
  // imports via the "@/" tsconfig alias, and this repo's vitest setup has no alias resolution
  // configured, importing the route module directly in a test fails at load time (verified:
  // "Cannot find package '@/lib/compile'"). isValidReport is exported from persist.ts
  // specifically so the route's validation logic is unit-testable without that import.
  it("rejects undefined, null, and arrays", () => {
    expect(isValidReport(undefined)).toBe(false);
    expect(isValidReport(null)).toBe(false);
    expect(isValidReport([])).toBe(false);
  });

  it("rejects non-object primitives", () => {
    expect(isValidReport("report")).toBe(false);
    expect(isValidReport(123)).toBe(false);
  });

  it("accepts a plain object", () => {
    expect(isValidReport({ scoreBefore: 10, scoreAfter: 90 })).toBe(true);
    expect(isValidReport({})).toBe(true);
  });
});
