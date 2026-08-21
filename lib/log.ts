/**
 * Progress logging for the `npm run dev` terminal.
 *
 * The scrape -> tailor -> compile path is almost entirely waiting: a page fetch, a Claude call
 * that runs over a minute, then tectonic. Without this the server prints nothing between "request
 * in" and "response out", so a slow run is indistinguishable from a hung one.
 */

// the suite drives these code paths constantly and the output would bury the actual test results.
// Keyed on VITEST rather than NODE_ENV because Vite (and Next) inline `process.env.NODE_ENV` as a
// literal at transform time, so it cannot be flipped at runtime; VITEST is a real runtime value.
// PROGRESS_LOG=1 forces it back on under the runner, for eyeballing the real output.
function isSilent(): boolean {
  return process.env.VITEST !== undefined && process.env.PROGRESS_LOG !== "1";
}

// how often a long-running step reports that it is still alive. Short enough that a ~70s Claude
// call shows several, long enough that it never becomes the noise it exists to prevent.
const HEARTBEAT_MS = 15000;

export type Logger = (message: string) => void;

// pure so the format is pinned by a test rather than by eyeballing the terminal
export function formatLine(scope: string, message: string): string {
  return `[${scope}] ${message}`;
}

// seconds for anything a human waits on, ms below that -- "0.4s" reads worse than "412ms"
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// extra sinks for the same lines the terminal gets -- the dev-only /api/logs SSE route registers
// one per connected browser so DevTools can mirror the terminal. Process-local by design: this is
// a local dev tool, not a log aggregator.
const subscribers = new Set<Logger>();

/** Registers a sink for every subsequent line. Returns the unsubscribe. */
export function subscribe(sink: Logger): () => void {
  subscribers.add(sink);
  return () => {
    subscribers.delete(sink);
  };
}

function emit(line: string): void {
  if (!isSilent()) console.log(line);

  for (const sink of subscribers) {
    try {
      sink(line);
    } catch {
      // a dead browser connection must never break a tailoring run mid-flight
    }
  }
}

export function logger(scope: string): Logger {
  return (message: string) => emit(formatLine(scope, message));
}

/** Elapsed-time handle: `const t = startTimer()` ... `t()` returns the formatted duration. */
export function startTimer(): () => string {
  const started = Date.now();
  return () => formatDuration(Date.now() - started);
}

/**
 * Runs `work`, reporting "still running" on an interval until it settles. Used for the steps that
 * can take minutes (the Claude call), so the terminal shows liveness rather than a dead prompt.
 */
export async function withHeartbeat<T>(log: Logger, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const timer = setInterval(() => {
    log(`  …still running · ${formatDuration(Date.now() - started)}`);
  }, HEARTBEAT_MS);
  // never let the heartbeat itself hold the process open (matters for one-shot scripts and tests)
  timer.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
