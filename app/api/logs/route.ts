import { subscribe } from "@/lib/log";
import { requireUser } from "@/lib/auth";

// a long-lived stream, so it must never be statically rendered or cached
export const dynamic = "force-dynamic";

// keeps the connection from idling out during the ~70s Claude call -- the exact window this
// endpoint exists to report on. A comment frame is ignored by EventSource, so it costs nothing.
const KEEPALIVE_MS = 30000;

/**
 * Server-sent events carrying the same progress lines the dev terminal prints, so the browser
 * DevTools console can mirror them live.
 *
 * Deliberately a side channel: /api/scrape, /api/tailor and /api/approve keep their exact
 * request/response contracts (and their 422/502 status codes), and neither they nor the tailoring
 * code know this exists.
 *
 * GATED TWICE, and it needs to be. lib/log.ts's subscriber registry is one process-wide Set with
 * no per-user tagging, so a subscriber sees EVERY user's progress: the job URLs they scraped, the
 * company and role they are applying to, their ATS scores, and the row ids of freshly saved
 * applications (which are exactly the valid /api/files/<id> targets). There is no way to scope
 * this stream per user without rebuilding the log sink, so it is restricted to a signed-in user on
 * a development server instead. The env check alone would not be enough -- a container running
 * `next dev` in production would sail straight through it.
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    // 404, not 403: in production this endpoint should not appear to exist at all
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const encoder = new TextEncoder();

  let unsubscribe: () => void = () => {};
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      // enqueueing after the client goes away throws; failing closed here (and dropping the
      // subscription) is what keeps a closed tab from breaking an in-flight run
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          unsubscribe();
          if (keepalive) clearInterval(keepalive);
        }
      };

      unsubscribe = subscribe((line) => send(`data: ${JSON.stringify(line)}\n\n`));
      keepalive = setInterval(() => send(`: keepalive\n\n`), KEEPALIVE_MS);

      send(`data: ${JSON.stringify("[logs] connected — server progress will appear here")}\n\n`);
    },

    cancel() {
      // the normal path: the tab closed or the page navigated away
      unsubscribe();
      if (keepalive) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
