import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/logs/route";
import { logger } from "@/lib/log";

// This stream is process-wide and untagged (lib/log.ts keeps one Set of subscribers), so a
// listener sees every user's job URLs, companies, roles and saved row ids. These tests exist to
// pin the two gates shut -- an earlier version of this file asserted the stream opened with no
// checks at all, which meant the suite was actively certifying the leak.
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ ok: true, user: { id: "u1", email: "a@b.c", name: null } })),
}));

const { requireUser } = await import("@/lib/auth");
const requireUserMock = vi.mocked(requireUser);

// the route is development-only; vitest runs with NODE_ENV="test", so every test that expects a
// stream has to say so explicitly
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  requireUserMock.mockResolvedValue({
    ok: true,
    user: { id: "u1", email: "a@b.c", name: null },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const signedInRequest = () => new Request("http://localhost/api/logs");

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

describe("GET /api/logs access control", () => {
  it("does not exist outside development, whatever the session says", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(signedInRequest());

    // 404 rather than 403: in production this endpoint should not advertise that it exists
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });

  it("refuses an anonymous listener even in development", async () => {
    requireUserMock.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET(signedInRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
  });
});

describe("GET /api/logs", () => {
  it("responds as an uncached event stream", async () => {
    const response = await GET(signedInRequest());

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");

    await response.body?.cancel();
  });

  it("greets the client, then forwards each progress line as an SSE data frame", async () => {
    const response = await GET(signedInRequest());
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
    const response = await GET(signedInRequest());
    const reader = response.body!.getReader();
    await readAvailable(reader); // greeting
    await reader.cancel();

    // if cancel had not unsubscribed, this would enqueue into a closed controller
    expect(() => logger("scrape")("after the tab closed")).not.toThrow();
  });
});
