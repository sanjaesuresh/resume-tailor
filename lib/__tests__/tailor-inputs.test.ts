import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "../db";
import { saveUserSettings } from "../settings";
import { resolveTailorInputs } from "../tailor-inputs";
import { DEFAULT_TAILOR_PROMPT } from "../prompts/tailor";

// same temp-db pattern as lib/__tests__/db.test.ts -- never the real tracker.db
function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-inputs-")), "tracker.db");
}

// inline fixture only; assets/base-resume.tex holds real personal data and must never reach a test
const VALID_TEX = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}";

describe("resolveTailorInputs", () => {
  let dbDir: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dbDir && fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  function freshDb(): void {
    const dbPath = tempDbPath();
    dbDir = path.dirname(dbPath);
    getDb(dbPath);
  }

  it("uses the user's own saved resume, whitelist and prompt", () => {
    vi.stubEnv("NODE_ENV", "production");
    freshDb();
    saveUserSettings("user-1", {
      baseResumeTex: VALID_TEX,
      skillsWhitelist: "Python\nRust",
      tailorPrompt: "my own rules",
    });

    const resolved = resolveTailorInputs("user-1");

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.inputs.baseTex).toBe(VALID_TEX);
    expect(resolved.inputs.whitelist).toEqual(["Python", "Rust"]);
    expect(resolved.inputs.systemPrompt).toBe("my own rules");
  });

  it("falls back to the built-in prompt when the user never customised one", () => {
    vi.stubEnv("NODE_ENV", "production");
    freshDb();
    saveUserSettings("user-1", { baseResumeTex: VALID_TEX });

    const resolved = resolveTailorInputs("user-1");

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // resolved at read time, NOT copied into the row -- improving the default must reach everyone
    // who kept it
    expect(resolved.inputs.systemPrompt).toBe(DEFAULT_TAILOR_PROMPT);
  });

  it("refuses rather than guessing when the user has saved no resume", () => {
    vi.stubEnv("NODE_ENV", "production");
    freshDb();

    const resolved = resolveTailorInputs("user-with-nothing");

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/Settings/);
  });

  it("NEVER falls back to an on-disk resume outside development", () => {
    // this is the whole safety property of the module. A deployed instance that quietly tailors
    // against whatever file happens to sit on its filesystem is the single-user bug this replaced,
    // and on this machine assets/base-resume.tex really does exist -- so if the env gate regressed,
    // this test would hand back the owner's actual resume to a user who saved none.
    vi.stubEnv("NODE_ENV", "production");
    freshDb();

    const resolved = resolveTailorInputs("user-with-nothing");

    expect(resolved.ok).toBe(false);
  });

  it("keeps one user's settings out of another's run", () => {
    vi.stubEnv("NODE_ENV", "production");
    freshDb();
    saveUserSettings("user-1", { baseResumeTex: VALID_TEX, skillsWhitelist: "Python" });
    saveUserSettings("user-2", {
      baseResumeTex: VALID_TEX.replace("Hello", "Different"),
      skillsWhitelist: "Rust",
    });

    const first = resolveTailorInputs("user-1");
    const second = resolveTailorInputs("user-2");

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.inputs.whitelist).toEqual(["Python"]);
    expect(second.inputs.whitelist).toEqual(["Rust"]);
    expect(first.inputs.baseTex).not.toBe(second.inputs.baseTex);
  });

  it("treats a saved-but-empty whitelist as strict, not as missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    freshDb();
    saveUserSettings("user-1", { baseResumeTex: VALID_TEX, skillsWhitelist: "" });

    const resolved = resolveTailorInputs("user-1");

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // empty means "introduce nothing new" -- the strict end of the guardrail, not a bypass
    expect(resolved.inputs.whitelist).toEqual([]);
  });
});
