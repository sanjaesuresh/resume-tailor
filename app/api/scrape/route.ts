import { scrapeJob } from "@/lib/scrape";
import { requireUser } from "@/lib/auth";
import { checkRateLimit, recordUsage } from "@/lib/ratelimit";

// thin wrapper over scrapeJob: maps its ok/error union to 200/422 so no raw HTML
// ever reaches the client — only the extracted description or an error message
export async function POST(request: Request) {
  // this makes the server fetch a URL of the caller's choosing. Unauthenticated, that is an open
  // proxy pointed at our own network -- and lib/scrape.ts still follows redirects, so the existing
  // private-address gate can be walked around by a public host that 302s inward (closed in phase 3).
  // A session at least means the request is attributable.
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const limit = checkRateLimit(auth.user.id, "scrape");
  if (!limit.allowed) {
    return Response.json(
      { error: `Rate limit reached (${limit.limit} fetches). Try again shortly.` },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } }
    );
  }

  try {
    const body = await request.json().catch(() => null);
    const url = body?.url;

    if (typeof url !== "string" || url.length === 0) {
      return Response.json({ error: "Missing url" }, { status: 422 });
    }

    const result = await scrapeJob(url);

    if (!result.ok) {
      // 422 tells the UI to fall back to the manual paste box
      return Response.json({ error: result.error }, { status: 422 });
    }

    // only a fetch that actually reached a posting counts -- a 422 for an unsupported board
    // should not spend the user's allowance
    recordUsage(auth.user.id, "scrape");
    return Response.json({ description: result.description });
  } catch {
    // belt-and-braces: scrapeJob already converts its own failures to the ok/error union,
    // but guarantee the 422 JSON contract (never raw HTML/an unhandled 500) even if
    // something upstream throws unexpectedly
    return Response.json({ error: "Failed to process job posting" }, { status: 422 });
  }
}
