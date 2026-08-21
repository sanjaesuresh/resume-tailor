import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { ASSETS_DIR } from "../config";
import { buildTectonicFailureLog, compileTex, compileWithAutoFix } from "../compile";

// use the committed sanitized sample (not the gitignored personal base-resume.tex)
// so this test is reproducible on any machine that clones the repo fresh
const SAMPLE_TEX_PATH = path.join(ASSETS_DIR, "base-resume.sample.tex");
const validTex = fs.readFileSync(SAMPLE_TEX_PATH, "utf-8");

describe("compileTex", () => {
  it(
    "compiles valid LaTeX to a PDF buffer",
    async () => {
      const result = await compileTex(validTex);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // PDF files begin with the "%PDF" magic bytes
        expect(result.pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
      }
    },
    // first run downloads/caches tectonic packages; can be slow
    120000
  );

  it("returns ok:false with a non-empty log for invalid LaTeX", async () => {
    const brokenTex = String.raw`\documentclass{article}
\begin{document}
\textbf{unclosed brace
\end{document}`;

    const result = await compileTex(brokenTex);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.log.length).toBeGreaterThan(0);
    }
  }, 30000);
});

describe("buildTectonicFailureLog", () => {
  it("uses stdout/stderr when tectonic actually ran and printed something", () => {
    const error = Object.assign(new Error("Command failed"), { code: undefined });
    const log = buildTectonicFailureLog("some output\n", "some warning\n", error);

    expect(log).toBe("some output\n\nsome warning");
  });

  it("falls back to the spawn error's message when stdout/stderr are both empty", () => {
    // simulates tectonic failing to spawn at all (missing binary, ENOENT, etc.)
    const error = Object.assign(new Error("spawn tectonic ENOENT"), { code: "ENOENT" });
    const log = buildTectonicFailureLog("", "", error);

    expect(log.length).toBeGreaterThan(0);
    expect(log).toContain("spawn tectonic ENOENT");
    expect(log).toContain("ENOENT");
  });
});

describe("compileWithAutoFix", () => {
  it(
    "recompiles with the fixer's corrected tex and reports it was used",
    async () => {
      const brokenTex = "this is not valid latex at all \\bad{";
      let fixerCalled = false;

      const fixFn = async (_tex: string, _log: string) => {
        fixerCalled = true;
        return validTex;
      };

      const result = await compileWithAutoFix(brokenTex, fixFn);

      expect(fixerCalled).toBe(true);
      expect(result.usedFix).toBe(true);
      expect(result.result.ok).toBe(true);
      if (result.result.ok) {
        expect(result.result.pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
      }
    },
    120000
  );

  it("resolves (does not reject) with the first failure when fixFn throws", async () => {
    const brokenTex = "this is not valid latex at all \\bad{";

    const throwingFixFn = async (_tex: string, _log: string): Promise<string> => {
      throw new Error("rate limited");
    };

    const { result, usedFix } = await compileWithAutoFix(brokenTex, throwingFixFn);

    expect(usedFix).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.log).toContain("rate limited");
      expect(result.log).toContain("auto-fix attempt failed");
    }
  }, 30000);
});
