import fs from "fs";
import { tailorResume } from "@/lib/tailor";
import { BASE_RESUME_PATH } from "@/lib/config";

// thin wrapper over tailorResume: maps the retry-loop result to JSON and turns any hard
// Anthropic-call failure (network, auth, every retry unparseable) into a 502 rather than
// letting an unhandled throw surface as a bare 500 with no readable message
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const jobDescription = body?.jobDescription;

  if (typeof jobDescription !== "string" || jobDescription.trim().length === 0) {
    return Response.json({ error: "Missing jobDescription" }, { status: 422 });
  }

  const feedback = typeof body?.feedback === "string" ? body.feedback : undefined;
  const previousTex = typeof body?.previousTex === "string" ? body.previousTex : undefined;

  try {
    const result = await tailorResume(jobDescription, { feedback, previousTex });
    // client renders a diff against the base resume, so it needs the untouched original tex
    // alongside the tailored one -- nothing here is persisted to disk or the DB
    const baseTex = fs.readFileSync(BASE_RESUME_PATH, "utf-8");

    return Response.json({
      tex: result.tex,
      company: result.company,
      role: result.role,
      violations: result.violations,
      report: result.report,
      baseTex,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to tailor resume";
    return Response.json({ error: message }, { status: 502 });
  }
}
