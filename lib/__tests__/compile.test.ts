import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { ASSETS_DIR } from "../config";
import {
  buildTectonicArgs,
  buildTectonicFailureLog,
  compileTex,
  compileWithAutoFix,
  createSemaphore,
  toBusyResult,
} from "../compile";

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

  it(
    "queues rather than drops a request beyond the module's real concurrency cap",
    async () => {
      // MAX_CONCURRENT_COMPILES is 2; the third call here must wait for a slot
      // and still succeed, proving the real (not just the abstracted) wiring queues
      const results = await Promise.all([compileTex(validTex), compileTex(validTex), compileTex(validTex)]);

      for (const result of results) {
        expect(result.ok).toBe(true);
      }
    },
    // three real compiles, some of them serialized behind the cap
    60000
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

  it("produces a non-empty log for a killed-by-timeout error with no output yet", () => {
    // simulates Node's execFile `timeout` option firing: the process is killed
    // by signal before printing anything, so code is null/undefined and stdout/
    // stderr are empty -- the caller must still get something actionable
    const error = Object.assign(new Error("Command failed: tectonic --untrusted --outdir ..."), {
      code: null,
      signal: "SIGTERM",
      killed: true,
    });
    const log = buildTectonicFailureLog("", "", error);

    expect(log.length).toBeGreaterThan(0);
    expect(log).toContain("Command failed");
  });
});

describe("buildTectonicArgs", () => {
  it("includes --untrusted since input is a stranger's LaTeX once this app is public", () => {
    const args = buildTectonicArgs("/tmp/dir/resume.tex", "/tmp/dir");

    expect(args).toContain("--untrusted");
  });

  it("still points tectonic at the right outdir and source file", () => {
    const args = buildTectonicArgs("/tmp/dir/resume.tex", "/tmp/dir");

    expect(args).toEqual(["--untrusted", "--outdir", "/tmp/dir", "/tmp/dir/resume.tex"]);
  });
});

describe("createSemaphore", () => {
  it("lets up to `maxConcurrent` callers hold a slot without waiting", async () => {
    const sem = createSemaphore(2, 1000);

    const release1 = await sem.acquire();
    const release2 = await sem.acquire();

    expect(typeof release1).toBe("function");
    expect(typeof release2).toBe("function");
  });

  it("makes a caller beyond the cap wait until a slot is released", async () => {
    const sem = createSemaphore(1, 1000);
    const release1 = await sem.acquire();

    let acquired = false;
    const pending = sem.acquire().then((release) => {
      acquired = true;
      return release;
    });

    // give the pending acquire() a chance to (wrongly) resolve early
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acquired).toBe(false);

    release1();
    const release2 = await pending;
    expect(acquired).toBe(true);
    release2();
  });

  it("rejects (does not throw) a caller that waits past queueTimeoutMs", async () => {
    const sem = createSemaphore(1, 30);
    await sem.acquire(); // hold the only slot for the whole test, never released

    await expect(sem.acquire()).rejects.toThrow(/timed out/i);
  });
});

describe("toBusyResult", () => {
  it("converts a queue-timeout error into a normal ok:false CompileResult", () => {
    const result = toBusyResult(new Error("timed out waiting for a compile slot"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.log).toContain("server busy");
      expect(result.log).toContain("timed out waiting for a compile slot");
    }
  });

  it("handles a non-Error rejection without throwing", () => {
    const result = toBusyResult("not an Error instance");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.log).toContain("not an Error instance");
    }
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
