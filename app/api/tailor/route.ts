import { tailorResume } from "@/lib/tailor";
import { MAX_JOB_DESCRIPTION_CHARS } from "@/lib/config";
import { activeProviderName } from "@/lib/provider";
import { requireUser } from "@/lib/auth";
import { resolveTailorInputs } from "@/lib/tailor-inputs";
import { checkRateLimit, recordUsage } from "@/lib/ratelimit";

// thin wrapper over tailorResume: maps the retry-loop result to JSON and turns any hard
// provider failure (network, auth, every retry unparseable) into a 502 rather than
// letting an unhandled throw surface as a bare 500 with no readable message
export async function POST(request: Request) {
  // this route returns baseTex -- a PII document with the owner's name, contact details and
  // employment history -- so the client can render a diff. Before this check it was readable by
  // anyone who could reach the server, with no cookie: one unauthenticated POST and you had the
  // whole document.
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  // the most expensive thing a user can trigger: up to three model calls billed to the owner's key
  const limit = checkRateLimit(auth.user.id, "tailor");
  if (!limit.allowed) {
    return Response.json(
      { error: `Rate limit reached (${limit.limit} tailoring runs). Try again later.` },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } }
    );
  }

  const body = await request.json().catch(() => null);
  const jobDescription = body?.jobDescription;

  if (typeof jobDescription !== "string" || jobDescription.trim().length === 0) {
    return Response.json({ error: "Missing jobDescription" }, { status: 422 });
  }
  if (jobDescription.length > MAX_JOB_DESCRIPTION_CHARS) {
    return Response.json({ error: "Job description is too long" }, { status: 413 });
  }

  // whose resume, whose whitelist, whose prompt -- resolved from the session user's settings
  // rather than read off the filesystem, which is what used to make this single-user
  const resolved = resolveTailorInputs(auth.user.id);
  if (!resolved.ok) {
    return Response.json({ error: resolved.error }, { status: 422 });
  }

  const feedback = typeof body?.feedback === "string" ? body.feedback : undefined;
  const previousTex = typeof body?.previousTex === "string" ? body.previousTex : undefined;

  try {
    const result = await tailorResume(jobDescription, resolved.inputs, { feedback, previousTex });
    // recorded only after the run actually succeeded, so a 422 or a provider outage does not
    // silently eat the user's allowance
    recordUsage(auth.user.id, "tailor");

    return Response.json({
      tex: result.tex,
      company: result.company,
      role: result.role,
      violations: result.violations,
      report: result.report,
      // the client diffs the tailored version against this; it is the user's own saved resume,
      // never a file picked up off the server
      baseTex: resolved.inputs.baseTex,
      provider: activeProviderName(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to tailor resume";
    // provider errors already name their own fix (bad key, unknown model); tagging the active
    // back end keeps a bare SDK/network message from being ambiguous about who failed
    return Response.json({ error: message, provider: activeProviderName() }, { status: 502 });
  }
}
