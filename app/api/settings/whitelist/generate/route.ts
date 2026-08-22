import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getUserSettings } from "@/lib/settings";
import { getProvider } from "@/lib/provider";
import { checkRateLimit, recordUsage } from "@/lib/ratelimit";
import { formatCount, logger, startTimer, withHeartbeat } from "@/lib/log";
import {
  isWhitelistBreadth,
  renderWhitelistDraft,
  whitelistPrompt,
  type WhitelistBreadth,
} from "@/lib/prompts/whitelist";

const SkillsSchema = z.object({
  present: z.array(z.string()),
  inferred: z.array(z.string()),
});

// a term longer than this is a phrase, not a technology, and the validator matches on capitalized
// terms -- letting sentences through would make the whitelist accept almost anything
const MAX_TERM_CHARS = 60;

/** Trims, drops empties and over-long entries, and dedupes case-insensitively while keeping the
    original casing, since the validator compares against how terms are written in a resume. */
function cleanTerms(terms: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed || trimmed.length > MAX_TERM_CHARS) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

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

  const body = await request.json().catch(() => null);
  const rawBreadth = (body as { breadth?: unknown } | null)?.breadth;
  // default to the narrowest width: an absent or malformed value must never silently widen the
  // guardrail, which is the one direction of this setting that can hurt someone
  const breadth: WhitelistBreadth = isWhitelistBreadth(rawBreadth) ? rawBreadth : 1;

  const settings = getUserSettings(auth.user.id);
  if (!settings.baseResumeTex) {
    return Response.json(
      { error: "Save your resume first — the draft is extracted from it." },
      { status: 422 }
    );
  }

  const log = logger("whitelist");
  const elapsed = startTimer();
  log(
    `extracting skills · width ${breadth} · ${formatCount(settings.baseResumeTex.length)} chars of resume…`
  );

  try {
    const provider = getProvider();
    const parsed = await withHeartbeat(log, () =>
      provider({
        system: whitelistPrompt(breadth),
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

    // one shared `seen` set across both groups, so a term the model listed as both present and
    // inferred stays in the present group only -- it is written in the resume, so it is not a guess
    const seen = new Set<string>();
    const present = cleanTerms(parsed.present, seen);
    const inferred = breadth === 1 ? [] : cleanTerms(parsed.inferred, seen);

    recordUsage(auth.user.id, "tailor");
    log(`✓ ${present.length} in resume · ${inferred.length} inferred · ${elapsed()}`);

    // returned, never saved: the user reviews and edits before this becomes the guardrail they
    // are held to
    return Response.json({
      whitelist: renderWhitelistDraft(present, inferred, breadth),
      counts: { present: present.length, inferred: inferred.length },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate a whitelist";
    log(`✗ ${message}`);
    return Response.json({ error: message }, { status: 502 });
  }
}
