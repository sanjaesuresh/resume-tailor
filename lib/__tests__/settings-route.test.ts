import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "../db";
import { DEFAULT_TAILOR_PROMPT } from "../prompts/tailor";

// the route resolves identity through requireUser; stubbing it keeps these tests about the
// settings contract rather than about better-auth, which needs a secret and its own tables
let currentUserId: string | null = "user-1";
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () =>
    currentUserId
      ? { ok: true as const, user: { id: currentUserId, email: "a@b.c", name: null } }
      : { ok: false as const, response: Response.json({ error: "Unauthorized" }, { status: 401 }) }
  ),
}));

const { GET, PUT } = await import("@/app/api/settings/route");

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-settings-route-")), "tracker.db");
}

const VALID_TEX = "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}";

function req(body: unknown): Request {
  return new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const getReq = () => new Request("http://localhost/api/settings");

describe("settings route", () => {
  let dbDir: string;

  beforeEach(() => {
    currentUserId = "user-1";
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);
  });

  afterEach(() => {
    if (dbDir && fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it("refuses an unauthenticated caller", async () => {
    currentUserId = null;
    expect((await GET(getReq())).status).toBe(401);
    expect((await PUT(req({ displayName: "x" }))).status).toBe(401);
  });

  it("serves the built-in prompt to a brand new account, flagged as the default", async () => {
    const body = await (await GET(getReq())).json();

    expect(body.settings.tailorPrompt).toBe(DEFAULT_TAILOR_PROMPT);
    expect(body.settings.isPromptDefault).toBe(true);
    expect(body.settings.resumeTex).toBeNull();
  });

  it("saves one section without disturbing the others", async () => {
    await PUT(req({ resumeTex: VALID_TEX }));
    await PUT(req({ displayName: "Ada" }));

    const body = await (await GET(getReq())).json();
    // the second save omitted resumeTex entirely; absent must mean "leave alone", because each
    // settings section saves independently and would otherwise wipe the other three
    expect(body.settings.resumeTex).toBe(VALID_TEX);
    expect(body.settings.displayName).toBe("Ada");
  });

  it("treats an explicit null on the prompt as a reset, not as an empty prompt", async () => {
    await PUT(req({ tailorPrompt: "my own rules" }));
    const custom = await (await GET(getReq())).json();
    expect(custom.settings.isPromptDefault).toBe(false);

    await PUT(req({ tailorPrompt: null }));
    const reset = await (await GET(getReq())).json();

    // reset must DELETE the override rather than copy the default text in, so a later improvement
    // to the default still reaches this user
    expect(reset.settings.isPromptDefault).toBe(true);
    expect(reset.settings.tailorPrompt).toBe(DEFAULT_TAILOR_PROMPT);
  });

  it("rejects a resume that is not LaTeX before it can fail at compile time", async () => {
    const res = await PUT(req({ resumeTex: "I am a plain text resume, not LaTeX at all." }));

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/LaTeX/i);
  });

  it("rejects an oversized document with 413 rather than storing it", async () => {
    const res = await PUT(req({ resumeTex: VALID_TEX + "x".repeat(500_001) }));

    expect(res.status).toBe(413);
    const body = await (await GET(getReq())).json();
    expect(body.settings.resumeTex).toBeNull();
  });

  it("rejects a non-string value instead of coercing it", async () => {
    expect((await PUT(req({ displayName: 42 }))).status).toBe(422);
  });

  it("ignores unknown fields rather than passing them to the query", async () => {
    const res = await PUT(req({ nonsense: "x" }));
    expect(res.status).toBe(422); // nothing recognised to update
  });

  it("keeps one user's settings invisible to another", async () => {
    await PUT(req({ resumeTex: VALID_TEX, displayName: "Ada" }));

    currentUserId = "user-2";
    const other = await (await GET(getReq())).json();

    expect(other.settings.resumeTex).toBeNull();
    expect(other.settings.displayName).toBeNull();
  });
});
