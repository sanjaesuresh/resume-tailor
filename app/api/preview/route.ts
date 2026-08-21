import { compileTex } from "@/lib/compile";
import { formatCount, logger, startTimer } from "@/lib/log";

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
  const log = logger("preview");

  const body = await request.json().catch(() => null);
  const tex = body?.tex;

  if (typeof tex !== "string" || tex.trim().length === 0) {
    return Response.json({ error: "Missing tex" }, { status: 422 });
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

  return new Response(new Uint8Array(result.pdf), {
    headers: {
      "content-type": "application/pdf",
      // a draft's preview is never worth caching; the next edit invalidates it immediately
      "cache-control": "no-store",
      "content-disposition": 'inline; filename="preview.pdf"',
    },
  });
}
