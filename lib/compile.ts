import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

export type CompileResult =
  | { ok: true; pdf: Buffer }
  | { ok: false; log: string };

// a resume compiles in low single-digit seconds once tectonic's resource bundle is
// cached; 20s leaves generous headroom over that without leaving a two-minute DoS
// window open to a stranger's document. this assumes the bundle is already warm
// (pre-fetched once, e.g. baked into the deployment image per phase 4, or after a
// single local `tectonic --version`) -- a genuinely cold machine's first-ever bundle
// download can legitimately exceed 20s and should happen outside the request path,
// not be accommodated by stretching every request's timeout back toward the old budget
const TECTONIC_TIMEOUT_MS = 20000;
// caps simultaneous tectonic child processes so a burst of requests queues for a
// slot instead of forking one process per request; 2 is conservative for a small
// container where tectonic is the CPU-heavy part of the request
const MAX_CONCURRENT_COMPILES = 2;
// bounds how long a request will wait for a slot before failing cleanly; roughly
// one compile-timeout's worth, since that's the longest a slot ahead in the queue
// should legitimately take to free up
const QUEUE_TIMEOUT_MS = 20000;
const SOURCE_FILENAME = "resume.tex";
const OUTPUT_FILENAME = "resume.pdf";

/**
 * A plain module-level semaphore (no dependency) bounding how many callers can
 * hold a slot at once. Callers beyond the cap wait in FIFO order for `release()`
 * to be called by whoever is ahead of them; a wait longer than `queueTimeoutMs`
 * rejects instead of hanging forever, so a slow/stuck compile can't wedge every
 * later request open-endedly.
 */
export function createSemaphore(maxConcurrent: number, queueTimeoutMs: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  function release(): void {
    const next = waiters.shift();
    if (next) {
      // hand the freed slot straight to the next waiter rather than
      // decrementing/incrementing, so `active` never dips below the true count
      next();
    } else {
      active--;
    }
  }

  function acquire(): Promise<() => void> {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const grant = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active++;
        resolve(release);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = waiters.indexOf(grant);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error("timed out waiting for a compile slot"));
      }, queueTimeoutMs);
      waiters.push(grant);
    });
  }

  return { acquire };
}

const compileSemaphore = createSemaphore(MAX_CONCURRENT_COMPILES, QUEUE_TIMEOUT_MS);

// converts a semaphore rejection into the same {ok:false} shape every other
// compile failure uses, so a busy server looks like a normal failure to callers
// (and to compileWithAutoFix, which should not try to "fix" a queue timeout)
export function toBusyResult(err: unknown): CompileResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, log: `server busy: ${message}` };
}

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

  let release: (() => void) | null = null;
  try {
    await fs.writeFile(sourcePath, tex, "utf-8");

    // wait for a compile slot before spawning tectonic; a timed-out wait means
    // the server is saturated, not that this document is broken, so it returns
    // through the normal CompileResult union rather than propagating as a throw
    try {
      release = await compileSemaphore.acquire();
    } catch (err) {
      return toBusyResult(err);
    }

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
    release?.();
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

// pure so the exact argv (in particular --untrusted) is assertable without spawning
export function buildTectonicArgs(sourcePath: string, tempDir: string): string[] {
  // input is a stranger's LaTeX once this app is public; --untrusted disables
  // tectonic's known-insecure features (e.g. \write18 shell-out, arbitrary file reads)
  return ["--untrusted", "--outdir", tempDir, sourcePath];
}

function runTectonic(sourcePath: string, tempDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "tectonic",
      buildTectonicArgs(sourcePath, tempDir),
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
