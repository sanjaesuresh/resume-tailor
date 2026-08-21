import { scrapeJob } from "@/lib/scrape";

// thin wrapper over scrapeJob: maps its ok/error union to 200/422 so no raw HTML
// ever reaches the client — only the extracted description or an error message
export async function POST(request: Request) {
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

    return Response.json({ description: result.description });
  } catch {
    // belt-and-braces: scrapeJob already converts its own failures to the ok/error union,
    // but guarantee the 422 JSON contract (never raw HTML/an unhandled 500) even if
    // something upstream throws unexpectedly
    return Response.json({ error: "Failed to process job posting" }, { status: 422 });
  }
}
