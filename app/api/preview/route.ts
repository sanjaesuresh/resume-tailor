import { compileTex } from "@/lib/compile";
import { formatCount, logger, startTimer } from "@/lib/log";
import { requireUser } from "@/lib/auth";
// tectonic still runs without --untrusted and with a 120s timeout (phase 3), so until then this
// cap and the session gate are what stand between this route and a free CPU sink
import { MAX_TEX_CHARS } from "@/lib/config";
import { checkRateLimit, recordUsage } from "@/lib/ratelimit";

/**
 * Compiles a draft to PDF for the review step's preview pane, and does nothing else: no
 * validation, no persistence, no tracker row. A draft the user never approves must leave nothing
 * behind, which is exactly why this cannot reuse /api/approve.
 *
 * Deliberately calls compileTex rather than compileWithAutoFix: the preview must show what THIS
 * tex renders as. Showing Claude-repaired output would misrepresent the document being approved --
 * the approve route runs the fixer, and reports when it did.
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  // shares the compile budget with /api/approve because it is the same cost: a tectonic process.
  // The review step can re-preview on every edit, so leaving this uncapped would make the cheapest
  // way to pin the box a user simply clicking around.
  const limit = checkRateLimit(auth.user.id, "compile");
  if (!limit.allowed) {
    return Response.json(
      { error: `Rate limit reached (${limit.limit} compiles). Try again shortly.` },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } }
    );
  }

  const log = logger("preview");

  const body = await request.json().catch(() => null);
  const tex = body?.tex;

  if (typeof tex !== "string" || tex.trim().length === 0) {
    return Response.json({ error: "Missing tex" }, { status: 422 });
  }
  if (tex.length > MAX_TEX_CHARS) {
    return Response.json({ error: "Document is too large to compile" }, { status: 413 });
  }

  const elapsed = startTimer();
  log(`compiling ${formatCount(tex.length)} chars for preview…`);

  const result = await compileTex(tex);

  if (!result.ok) {
    // same 422 + log shape the approve route uses for a failed compile, so the UI renders it the
    // same way -- and the user learns the document is broken before clicking Approve
    log(`✗ preview compile failed · ${elapsed()}`);
    return Response.json({ error: "Preview compilation failed", log: result.log }, { status: 422 });
  }

  log(`✓ preview compiled · ${formatCount(result.pdf.length)} bytes · ${elapsed()}`);
  // recorded only for a compile that actually produced a PDF -- a document that fails to build
  // already cost the user their time, and it should not also cost their allowance
  recordUsage(auth.user.id, "compile");

  return new Response(new Uint8Array(result.pdf), {
    headers: {
      "content-type": "application/pdf",
      // a draft's preview is never worth caching; the next edit invalidates it immediately
      "cache-control": "no-store",
      "content-disposition": 'inline; filename="preview.pdf"',
    },
  });
}
