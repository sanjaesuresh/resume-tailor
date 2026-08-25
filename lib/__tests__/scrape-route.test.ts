import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/scrape/route";
import { getDb } from "@/lib/db";
import { RATE_LIMITS } from "@/lib/ratelimit";
import { scrapeJob } from "@/lib/scrape";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ ok: true, user: { id: "u1", email: "a@b.c", name: null } })),
}));

vi.mock("@/lib/scrape", () => ({
  scrapeJob: vi.fn(async () => ({
    ok: true,
    description: "We are hiring a Backend Engineer to build services.",
  })),
}));

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-scrape-route-")), "tracker.db");
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function usageCount(): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM usage_events").get() as { n: number }).n;
}

describe("POST /api/scrape rate limiting", () => {
  let dbDir: string;

  beforeEach(() => {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);
    vi.mocked(scrapeJob).mockClear();
  });

  afterEach(() => {
    if (dbDir && fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("does not consume quota for malformed cheap input", async () => {
    const response = await post({});

    expect(response.status).toBe(422);
    expect(vi.mocked(scrapeJob)).not.toHaveBeenCalled();
    expect(usageCount()).toBe(0);
  });

  it("consumes quota when the scrape attempt fails", async () => {
    vi.mocked(scrapeJob).mockResolvedValueOnce({
      ok: false,
      error: "Could not extract a job description from this page",
    });

    const response = await post({ url: "https://example.com/job" });

    expect(response.status).toBe(422);
    expect(usageCount()).toBe(1);
  });

  it("refuses once failed scrape attempts exhaust the scrape window", async () => {
    vi.mocked(scrapeJob).mockResolvedValue({
      ok: false,
      error: "Could not extract a job description from this page",
    });

    for (let i = 0; i < RATE_LIMITS.scrape.limit; i++) {
      const response = await post({ url: "https://example.com/job" });
      expect(response.status).toBe(422);
    }

    const refused = await post({ url: "https://example.com/job" });

    expect(refused.status).toBe(429);
    expect(vi.mocked(scrapeJob)).toHaveBeenCalledTimes(RATE_LIMITS.scrape.limit);
    expect(usageCount()).toBe(RATE_LIMITS.scrape.limit);
  });
});
