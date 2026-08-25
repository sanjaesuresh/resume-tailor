import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/settings/whitelist/generate/route";
import { getDb } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  settings: { baseResumeTex: "\\documentclass{article}\\begin{document}Python\\end{document}" } as {
    baseResumeTex: string | null;
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ ok: true, user: { id: "u1", email: "a@b.c", name: null } })),
}));

vi.mock("@/lib/settings", () => ({
  getUserSettings: vi.fn(() => mocks.settings),
}));

vi.mock("@/lib/provider", () => ({
  getProvider: vi.fn(() => mocks.provider),
}));

function tempDbPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-whitelist-generate-route-")),
    "tracker.db"
  );
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/settings/whitelist/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function usageCount(): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM usage_events").get() as { n: number }).n;
}

describe("POST /api/settings/whitelist/generate rate limiting", () => {
  let dbDir: string;

  beforeEach(() => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);
    mocks.settings = { baseResumeTex: "\\documentclass{article}\\begin{document}Python\\end{document}" };
    mocks.provider.mockReset();
    mocks.provider.mockResolvedValue({ present: ["Python"], inferred: [] });
  });

  afterEach(() => {
    if (dbDir && fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("does not consume quota when no resume is saved", async () => {
    mocks.settings = { baseResumeTex: null };

    const response = await post({ breadth: 1 });

    expect(response.status).toBe(422);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(usageCount()).toBe(0);
  });

  it("consumes quota when the model attempt fails", async () => {
    mocks.provider.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await post({ breadth: 1 });

    expect(response.status).toBe(502);
    expect(mocks.provider).toHaveBeenCalledOnce();
    expect(usageCount()).toBe(1);
  });
});
