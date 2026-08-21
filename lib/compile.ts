import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

export type CompileResult =
  | { ok: true; pdf: Buffer }
  | { ok: false; log: string };

const TECTONIC_TIMEOUT_MS = 120000;
const SOURCE_FILENAME = "resume.tex";
const OUTPUT_FILENAME = "resume.pdf";

/**
 * Compiles a LaTeX document string to a PDF using tectonic.
 *
 * Writes `tex` into a fresh temp directory, runs `tectonic` against it, and
 * returns the produced PDF bytes on success. On failure, returns tectonic's
 * combined stdout+stderr as a log so a caller (or LLM auto-fixer) can act on it.
 * The temp directory is always removed, whether compilation succeeds or fails.
 */
export async function compileTex(tex: string): Promise<CompileResult> {
  // unique per-call dir avoids collisions between concurrent compiles and
  // keeps tectonic's aux/output files isolated from the caller's filesystem
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-tailor-compile-"));
  const sourcePath = path.join(tempDir, SOURCE_FILENAME);
  const outputPath = path.join(tempDir, OUTPUT_FILENAME);

  try {
    await fs.writeFile(sourcePath, tex, "utf-8");

    const log = await runTectonic(sourcePath, tempDir);

    try {
      const pdf = await fs.readFile(outputPath);
      return { ok: true, pdf };
    } catch {
      // tectonic exited 0 but produced no PDF (shouldn't normally happen, but
      // treat it as a failure with whatever it printed rather than throwing)
      return { ok: false, log: log || "tectonic did not produce a PDF output" };
    }
  } catch (err) {
    const log = err instanceof TectonicError ? err.log : String(err);
    return { ok: false, log };
  } finally {
    // best-effort cleanup; a leaked temp dir shouldn't fail the compile itself
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// carries tectonic's combined output alongside the thrown error so the
// catch block in compileTex can surface it as the failure log
class TectonicError extends Error {
  log: string;
  constructor(log: string) {
    super("tectonic compilation failed");
    this.log = log;
  }
}

// pure so it's testable without actually spawning (or failing to spawn) tectonic;
// if tectonic never ran (ENOENT, EACCES, etc.) stdout/stderr are both empty, so
// fall back to the spawn error itself rather than handing the auto-fixer an
// empty log for a problem that has nothing to do with the tex
export function buildTectonicFailureLog(
  stdout: string,
  stderr: string,
  error: { message: string; code?: string | number | null }
): string {
  const log = `${stdout}\n${stderr}`.trim();
  if (log) return log;
  const code = error.code;
  return code ? `${error.message} (${code})` : error.message;
}

function runTectonic(sourcePath: string, tempDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "tectonic",
      ["--outdir", tempDir, sourcePath],
      { timeout: TECTONIC_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new TectonicError(buildTectonicFailureLog(stdout, stderr, error)));
          return;
        }
        resolve(`${stdout}\n${stderr}`.trim());
      }
    );
  });
}

export type FixFn = (tex: string, log: string) => Promise<string>;

export interface AutoFixResult {
  result: CompileResult;
  usedFix: boolean;
}

/**
 * Compiles `tex`; if it fails, asks `fixFn` (a Claude-backed corrector
 * supplied by the caller) for a corrected document exactly once, then
 * recompiles and returns that second attempt's result.
 */
export async function compileWithAutoFix(tex: string, fixFn: FixFn): Promise<AutoFixResult> {
  const firstResult = await compileTex(tex);
  if (firstResult.ok) {
    return { result: firstResult, usedFix: false };
  }

  // fixFn is caller-supplied (Claude-backed) and can throw for reasons unrelated
  // to the tex itself (network error, rate limit, malformed response); keep that
  // from turning a normal compile failure into a rejected promise
  let fixedTex: string;
  try {
    fixedTex = await fixFn(tex, firstResult.log);
  } catch (err) {
    const note = `\n\n[auto-fix attempt failed: ${String(err instanceof Error ? err.message : err)}]`;
    return {
      result: { ok: false, log: firstResult.log + note },
      usedFix: false,
    };
  }

  const secondResult = await compileTex(fixedTex);
  return { result: secondResult, usedFix: true };
}
