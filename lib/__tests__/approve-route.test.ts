import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/approve/route";
import { compileWithAutoFix } from "@/lib/compile";
import { getDb } from "@/lib/db";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ ok: true, user: { id: "u1", email: "a@b.c", name: null } })),
}));

vi.mock("@/lib/compile", () => ({
  compileWithAutoFix: vi.fn(async () => ({
    result: { ok: false, log: "tectonic failed" },
    usedFix: false,
  })),
}));

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-approve-route-")), "tracker.db");
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function usageCount(): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM usage_events").get() as { n: number }).n;
}

const validPayload = {
  tex: "\\documentclass{article}\\begin{document}hi\\end{document}",
  company: "Acme",
  role: "Engineer",
  report: { scoreBefore: 10, scoreAfter: 80 },
};

describe("POST /api/approve rate limiting", () => {
  let dbDir: string;

  beforeEach(() => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);
    vi.mocked(compileWithAutoFix).mockClear();
  });

  afterEach(() => {
    if (dbDir && fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("does not consume quota for malformed cheap input", async () => {
    const response = await post({ ...validPayload, tex: "" });

    expect(response.status).toBe(422);
    expect(vi.mocked(compileWithAutoFix)).not.toHaveBeenCalled();
    expect(usageCount()).toBe(0);
  });

  it("consumes quota when compilation fails", async () => {
    const response = await post(validPayload);

    expect(response.status).toBe(422);
    expect(vi.mocked(compileWithAutoFix)).toHaveBeenCalledOnce();
    expect(usageCount()).toBe(1);
  });
});
