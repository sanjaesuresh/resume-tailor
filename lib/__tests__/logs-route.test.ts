import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/logs/route";
import { logger } from "@/lib/log";

// reads whatever is currently buffered on the stream, then releases the lock -- enough to assert
// what arrived without waiting on a stream that stays open by design
async function readAvailable(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks = 1
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < chunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe("GET /api/logs", () => {
  it("responds as an uncached event stream", async () => {
    const response = await GET();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");

    await response.body?.cancel();
  });

  it("greets the client, then forwards each progress line as an SSE data frame", async () => {
    const response = await GET();
    const reader = response.body!.getReader();

    const greeting = await readAvailable(reader);
    expect(greeting).toMatch(/^data: /);
    expect(greeting).toContain("connected");

    logger("tailor")("attempt 1/3 · prompt 26,637 chars");
    const frame = await readAvailable(reader);

    // JSON-encoded so a multi-line or special-character message can never break the frame
    expect(frame).toBe(`data: ${JSON.stringify("[tailor] attempt 1/3 · prompt 26,637 chars")}\n\n`);

    await reader.cancel();
  });

  it("unsubscribes on cancel, so a closed tab stops receiving", async () => {
    const response = await GET();
    const reader = response.body!.getReader();
    await readAvailable(reader); // greeting
    await reader.cancel();

    // if cancel had not unsubscribed, this would enqueue into a closed controller
    expect(() => logger("scrape")("after the tab closed")).not.toThrow();
  });
});
