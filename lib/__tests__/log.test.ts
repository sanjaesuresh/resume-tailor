import { describe, expect, it, vi } from "vitest";
import {
  formatCount,
  formatDuration,
  formatLine,
  logger,
  startTimer,
  subscribe,
  withHeartbeat,
} from "../log";

describe("progress log formatting", () => {
  it("prefixes every line with its scope", () => {
    expect(formatLine("scrape", "GET example.com/job/1")).toBe("[scrape] GET example.com/job/1");
  });

  it("reports sub-second work in ms and anything slower in seconds", () => {
    expect(formatDuration(412)).toBe("412ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(68234)).toBe("68.2s");
  });

  it("groups long counts so byte and character totals stay readable", () => {
    expect(formatCount(16337)).toBe("16,337");
    expect(formatCount(412)).toBe("412");
  });

  it("stays silent under vitest so the suite's own output is not buried", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger("scrape")("this must not print");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("prints when PROGRESS_LOG=1 forces it on under the runner", () => {
    // the same switch the dev server takes (no VITEST set) -- proves the logger actually emits,
    // rather than only proving it stays quiet
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("PROGRESS_LOG", "1");

    logger("tailor")("attempt 1/3");

    expect(spy).toHaveBeenCalledWith("[tailor] attempt 1/3");
    vi.unstubAllEnvs();
    spy.mockRestore();
  });
});

describe("subscribers (the /api/logs SSE sink)", () => {
  it("delivers every line to a subscriber, and stops once unsubscribed", () => {
    const lines: string[] = [];
    const unsubscribe = subscribe((line) => lines.push(line));
    const log = logger("tailor");

    log("attempt 1/3");
    unsubscribe();
    log("this one must not arrive");

    expect(lines).toEqual(["[tailor] attempt 1/3"]);
  });

  it("delivers even while the terminal is silenced, so the browser is not gated on it", () => {
    // the suite runs silenced; a subscriber must still receive, or DevTools output would depend
    // on the terminal's switch
    const lines: string[] = [];
    const unsubscribe = subscribe((line) => lines.push(line));

    logger("scrape")("GET example.com/job/1");
    unsubscribe();

    expect(lines).toEqual(["[scrape] GET example.com/job/1"]);
  });

  it("survives a throwing subscriber -- a dead browser connection cannot break a tailoring run", () => {
    const lines: string[] = [];
    const unsubscribeBad = subscribe(() => {
      throw new Error("connection closed");
    });
    const unsubscribeGood = subscribe((line) => lines.push(line));

    expect(() => logger("tailor")("still running")).not.toThrow();
    // the healthy subscriber still got it
    expect(lines).toEqual(["[tailor] still running"]);

    unsubscribeBad();
    unsubscribeGood();
  });
});

describe("startTimer", () => {
  it("formats the elapsed time since it was created", async () => {
    const elapsed = startTimer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(elapsed()).toMatch(/^\d+ms$/);
  });
});

describe("withHeartbeat", () => {
  it("returns the wrapped result and clears its interval", async () => {
    const clear = vi.spyOn(global, "clearInterval");
    const result = await withHeartbeat(
      () => {},
      async () => "done"
    );

    expect(result).toBe("done");
    // a leaked interval would keep logging (and holding a handle) long after the work finished
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it("clears its interval even when the wrapped work throws", async () => {
    const clear = vi.spyOn(global, "clearInterval");

    await expect(
      withHeartbeat(
        () => {},
        async () => {
          throw new Error("provider exploded");
        }
      )
    ).rejects.toThrow("provider exploded");

    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
