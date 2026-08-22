import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "../db";
import { getUserSettings, saveUserSettings, parseWhitelist } from "../settings";

// each test gets its own temp-file db path so tests never share state or clobber the real
// tracker.db; getDb(dbPath) re-points the module's memoized connection at that path for the
// duration of the test -- same pattern as lib/__tests__/db.test.ts
function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resume-tailor-settings-")), "tracker.db");
}

// inline fixtures only -- never assets/base-resume.tex or assets/skills-whitelist.md, which hold
// real personal data and must never reach a test
const VALID_TEX = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}";

describe("settings", () => {
  let dbDir: string;

  afterEach(() => {
    if (dbDir && fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  describe("getUserSettings", () => {
    it("returns an all-null object for a user with no row yet", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      expect(getUserSettings("brand-new-user")).toEqual({
        displayName: null,
        baseResumeTex: null,
        skillsWhitelist: null,
        tailorPrompt: null,
        updatedAt: null,
      });
    });
  });

  describe("saveUserSettings", () => {
    it("round-trips a full save through getUserSettings", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      const saved = saveUserSettings("user-1", {
        displayName: "Jordan Lee",
        baseResumeTex: VALID_TEX,
        skillsWhitelist: "TypeScript\nPostgreSQL",
        tailorPrompt: "Custom instructions.",
      });

      expect(saved.displayName).toBe("Jordan Lee");
      expect(saved.baseResumeTex).toBe(VALID_TEX);
      expect(saved.skillsWhitelist).toBe("TypeScript\nPostgreSQL");
      expect(saved.tailorPrompt).toBe("Custom instructions.");
      expect(saved.updatedAt).not.toBeNull();

      const fetched = getUserSettings("user-1");
      expect(fetched).toEqual(saved);
    });

    it("leaves a key absent from the patch unchanged", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      saveUserSettings("user-1", { displayName: "Original Name", tailorPrompt: "Original prompt" });
      const second = saveUserSettings("user-1", { displayName: "Updated Name" });

      // tailorPrompt was never mentioned in the second patch, so it must survive untouched
      expect(second.displayName).toBe("Updated Name");
      expect(second.tailorPrompt).toBe("Original prompt");
    });

    it("writes an explicit null, clearing a previously-saved value", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      saveUserSettings("user-1", { tailorPrompt: "Custom prompt" });
      const cleared = saveUserSettings("user-1", { tailorPrompt: null });

      // this is the reset-to-default button's contract: explicit null must win over "leave alone",
      // not be treated as falsy-and-ignored
      expect(cleared.tailorPrompt).toBeNull();
    });

    it("distinguishes absent from explicit null across multiple fields in one call", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      saveUserSettings("user-1", {
        displayName: "Kept Name",
        skillsWhitelist: "Kept, whitelist",
        tailorPrompt: "Kept prompt",
      });

      // clear tailorPrompt only; displayName and skillsWhitelist are absent from this patch
      const result = saveUserSettings("user-1", { tailorPrompt: null });

      expect(result.displayName).toBe("Kept Name");
      expect(result.skillsWhitelist).toBe("Kept, whitelist");
      expect(result.tailorPrompt).toBeNull();
    });

    it("stamps updated_at on every save, including a patch that clears a field", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      const first = saveUserSettings("user-1", { displayName: "A" });
      const second = saveUserSettings("user-1", { tailorPrompt: null });

      expect(first.updatedAt).not.toBeNull();
      expect(second.updatedAt).not.toBeNull();
    });

    it("two users' settings never bleed into each other", () => {
      const dbPath = tempDbPath();
      dbDir = path.dirname(dbPath);
      getDb(dbPath);

      saveUserSettings("user-1", { displayName: "Alice" });
      saveUserSettings("user-2", { displayName: "Bob" });

      expect(getUserSettings("user-1").displayName).toBe("Alice");
      expect(getUserSettings("user-2").displayName).toBe("Bob");
    });

    describe("size caps", () => {
      it("accepts baseResumeTex at exactly the cap and rejects one char over", () => {
        const dbPath = tempDbPath();
        dbDir = path.dirname(dbPath);
        getDb(dbPath);

        const padding = "%".repeat(500_000 - VALID_TEX.length);
        const atCap = VALID_TEX + padding;
        expect(atCap.length).toBe(500_000);

        expect(() => saveUserSettings("user-1", { baseResumeTex: atCap })).not.toThrow();
        expect(() => saveUserSettings("user-1", { baseResumeTex: atCap + "x" })).toThrow(
          /too large/
        );
      });

      it("accepts skillsWhitelist at exactly the cap and rejects one char over", () => {
        const dbPath = tempDbPath();
        dbDir = path.dirname(dbPath);
        getDb(dbPath);

        const atCap = "a".repeat(32_000);
        expect(() => saveUserSettings("user-1", { skillsWhitelist: atCap })).not.toThrow();
        expect(() => saveUserSettings("user-1", { skillsWhitelist: atCap + "x" })).toThrow(
          /too large/
        );
      });

      it("accepts tailorPrompt at exactly the cap and rejects one char over", () => {
        const dbPath = tempDbPath();
        dbDir = path.dirname(dbPath);
        getDb(dbPath);

        const atCap = "a".repeat(32_000);
        expect(() => saveUserSettings("user-1", { tailorPrompt: atCap })).not.toThrow();
        expect(() => saveUserSettings("user-1", { tailorPrompt: atCap + "x" })).toThrow(
          /too large/
        );
      });

      it("accepts displayName at exactly the cap and rejects one char over", () => {
        const dbPath = tempDbPath();
        dbDir = path.dirname(dbPath);
        getDb(dbPath);

        const atCap = "a".repeat(100);
        expect(() => saveUserSettings("user-1", { displayName: atCap })).not.toThrow();
        expect(() => saveUserSettings("user-1", { displayName: atCap + "x" })).toThrow(
          /at most 100/
        );
      });
    });

    describe("LaTeX validation", () => {
      it("rejects a non-empty baseResumeTex with no LaTeX document markers", () => {
        const dbPath = tempDbPath();
        dbDir = path.dirname(dbPath);
        getDb(dbPath);

        expect(() =>
          saveUserSettings("user-1", { baseResumeTex: "Jordan Lee\nSoftware Engineer\njordan@example.com" })
        ).toThrow(/LaTeX/);
      });

      it("accepts a document containing only \\begin{document} without \\documentclass", () => {
        const dbPath = tempDbPath();
        dbDir = path.dirname(dbPath);
        getDb(dbPath);

        expect(() =>
          saveUserSettings("user-1", { baseResumeTex: "\\begin{document}\nHello\n\\end{document}" })
        ).not.toThrow();
      });

      it("allows an empty baseResumeTex through (nothing uploaded yet)", () => {
        const dbPath = tempDbPath();
        dbDir = path.dirname(dbPath);
        getDb(dbPath);

        expect(() => saveUserSettings("user-1", { baseResumeTex: "" })).not.toThrow();
      });
    });

    describe("display name sanitization", () => {
      it("strips quotes, backslashes, and CR/LF before storing", () => {
        const dbPath = tempDbPath();
        dbDir = path.dirname(dbPath);
        getDb(dbPath);

        const result = saveUserSettings("user-1", {
          displayName: 'Jordan "The Closer" Lee\\\r\n',
        });

        expect(result.displayName).toBe("Jordan The Closer Lee");
      });
    });
  });

  describe("parseWhitelist", () => {
    it("keeps short skill lines and drops blanks, headers, and long prose", () => {
      const markdown = [
        "# Skills Whitelist",
        "",
        "This is a short paragraph of prose explaining what this file is for and how to edit it.",
        "",
        "TypeScript",
        "PostgreSQL, Redis",
        "  Kubernetes  ",
      ].join("\n");

      expect(parseWhitelist(markdown)).toEqual([
        "TypeScript",
        "PostgreSQL, Redis",
        "Kubernetes",
      ]);
    });

    it("drops a line with more than 6 words but keeps one with exactly 6", () => {
      const sixWords = "one two three four five six";
      const sevenWords = "one two three four five six seven";
      const markdown = [sixWords, sevenWords].join("\n");

      expect(parseWhitelist(markdown)).toEqual([sixWords]);
    });

    it("drops every line starting with #, regardless of heading level", () => {
      const markdown = ["# Title", "## Subheading", "Docker"].join("\n");
      expect(parseWhitelist(markdown)).toEqual(["Docker"]);
    });
  });
});
