import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getUserSettings } from "@/lib/settings";
import { getProvider } from "@/lib/provider";
import { checkRateLimit, recordUsage } from "@/lib/ratelimit";
import { formatCount, logger, startTimer, withHeartbeat } from "@/lib/log";

const SkillsSchema = z.object({ skills: z.array(z.string()) });

/**
 * Deliberately an EXTRACTION prompt, not a suggestion one. The whitelist is what lib/validator.ts
 * checks new capitalized terms against, so anything this invents becomes a technology the user is
 * then permitted to claim on a resume. Asking for "relevant skills" would quietly manufacture
 * exactly the fabrication the whole guardrail exists to prevent -- so the instruction is to copy
 * what is already written down, and nothing else.
 */
const EXTRACTION_PROMPT = `You extract technology names from a LaTeX resume.

Return every distinct technology, language, framework, library, platform, database, tool, and
methodology that ALREADY APPEARS in the document.

Rules:
- Copy terms as they are written in the document. Do not translate, expand, or normalize them.
- Do NOT add anything that is not present, however obviously related. If the resume says
  "PostgreSQL", do not also return "SQL", "databases", or "MySQL".
- Do not infer a skill from a job title, a company name, or a degree.
- Exclude company names, school names, person names, city names, and section headings.
- Exclude generic prose (for example "collaboration", "communication", "teamwork").
- Strip LaTeX markup from the terms you return.

Return a JSON object with a single field "skills": an array of strings, one term each, no
duplicates.`;

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  // a model call billed to the owner's key, so it draws on the same budget as tailoring. It is a
  // once-per-resume action, so sharing that allowance costs a real user nothing.
  const limit = checkRateLimit(auth.user.id, "tailor");
  if (!limit.allowed) {
    return Response.json(
      { error: `Rate limit reached. Try again later.` },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } }
    );
  }

  const settings = getUserSettings(auth.user.id);
  if (!settings.baseResumeTex) {
    return Response.json(
      { error: "Save your resume first — the draft is extracted from it." },
      { status: 422 }
    );
  }

  const log = logger("whitelist");
  const elapsed = startTimer();
  log(`extracting skills from ${formatCount(settings.baseResumeTex.length)} chars of resume…`);

  try {
    const provider = getProvider();
    const parsed = await withHeartbeat(log, () =>
      provider({
        system: EXTRACTION_PROMPT,
        user: `Resume (LaTeX):\n${settings.baseResumeTex}`,
        schema: SkillsSchema,
      })
    );

    if (!parsed) {
      return Response.json(
        { error: "Could not read a skills list back. Try again, or write the list yourself." },
        { status: 502 }
      );
    }

    // deduped case-insensitively but returned in the model's original casing, since the validator
    // compares against how terms are actually written in a resume
    const seen = new Set<string>();
    const skills = parsed.skills
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0 && skill.length <= 60)
      .filter((skill) => {
        const key = skill.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    recordUsage(auth.user.id, "tailor");
    log(`✓ ${skills.length} skills · ${elapsed()}`);

    // returned, never saved: the user reviews and edits before this becomes the guardrail they
    // are held to
    return Response.json({ whitelist: skills.join("\n") });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate a whitelist";
    log(`✗ ${message}`);
    return Response.json({ error: message }, { status: 502 });
  }
}
