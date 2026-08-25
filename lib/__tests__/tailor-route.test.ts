import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tailor/route";
import { getDb } from "@/lib/db";
import { RATE_LIMITS } from "@/lib/ratelimit";
import { tailorResume } from "@/lib/tailor";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ ok: true, user: { id: "u1", email: "a@b.c", name: null } })),
}));

vi.mock("@/lib/provider", () => ({
  activeProviderName: vi.fn(() => "test-provider"),
}));

vi.mock("@/lib/tailor-inputs", () => ({
  resolveTailorInputs: vi.fn(() => ({
    ok: true,
    inputs: { baseTex: "\\documentclass{article}", whitelist: [], systemPrompt: "Tailor it" },
  })),
}));

vi.mock("@/lib/tailor", () => ({
  tailorResume: vi.fn(async () => ({
    tex: "\\documentclass{article}\\begin{document}hi\\end{document}",
    company: "Acme",
    role: "Engineer",
    violations: [],
    report: {},
  })),
}));

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-tailor-route-")), "tracker.db");
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/tailor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function usageCount(): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM usage_events").get() as { n: number }).n;
}

describe("POST /api/tailor rate limiting", () => {
  let dbDir: string;

  beforeEach(() => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);
    vi.mocked(tailorResume).mockClear();
  });

  afterEach(() => {
    if (dbDir && fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("does not consume quota for malformed cheap input", async () => {
    const response = await post({ jobDescription: "   " });

    expect(response.status).toBe(422);
    expect(vi.mocked(tailorResume)).not.toHaveBeenCalled();
    expect(usageCount()).toBe(0);
  });

  it("consumes quota when the model attempt fails", async () => {
    vi.mocked(tailorResume).mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await post({ jobDescription: "Build backend services in TypeScript." });

    expect(response.status).toBe(502);
    expect(usageCount()).toBe(1);
  });

  it("refuses once failed model attempts exhaust the tailoring window", async () => {
    vi.mocked(tailorResume).mockRejectedValue(new Error("provider unavailable"));

    for (let i = 0; i < RATE_LIMITS.tailor.limit; i++) {
      const response = await post({ jobDescription: "Build backend services in TypeScript." });
      expect(response.status).toBe(502);
    }

    const refused = await post({ jobDescription: "Build backend services in TypeScript." });

    expect(refused.status).toBe(429);
    expect(vi.mocked(tailorResume)).toHaveBeenCalledTimes(RATE_LIMITS.tailor.limit);
    expect(usageCount()).toBe(RATE_LIMITS.tailor.limit);
  });
});
