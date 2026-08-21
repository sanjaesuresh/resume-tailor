import { subscribe } from "@/lib/log";

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
 */
export async function GET() {
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
