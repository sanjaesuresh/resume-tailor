import { z } from "zod";
import { MODEL, PROVIDER } from "./config";
import { extractRelevantSections } from "./jobtext";
import { formatCount, logger, startTimer, withHeartbeat } from "./log";
import { getProvider, type ClaudeProvider } from "./provider";
import { validateTailored, type Rule } from "./validator";
import { buildReport, type AtsReport } from "./ats";

// initial attempt + this many follow-ups = 3 Claude calls max per tailoring run (brief: "max 2
// retries total") -- bounded so a persistently-violating model can never loop forever/run up cost
const MAX_RETRIES = 2;

// structured-output contract for the tailoring call (Task 6 brief) -- deliberately distinct from
// the compile auto-fixer's `{ tex }`-only schema (Task 8), which is not this module's concern
const TailoredResumeSchema = z.object({
  company: z.string(),
  role: z.string(),
  tex: z.string(),
});

export type TailoredResume = z.infer<typeof TailoredResumeSchema>;

// validator.ts's `Rule` union is deliberately closed to the four deterministic, code-enforced
// checks -- a totally unparseable Claude response isn't one of those (there's no tex to check
// rules against at all), so it gets its own local tag instead of widening that shared union
type ParseFailureRule = "unparseable-response";

// structurally a superset of `Violation` (same rule/message/line shape, wider `rule` type) so the
// two combine into one coherent array without either side needing a cast
export interface TailorViolation {
  rule: Rule | ParseFailureRule;
  message: string;
  line?: number;
}

export interface TailorResult {
  tex: string;
  company: string;
  role: string;
  violations: TailorViolation[];
  report: AtsReport;
}

/**
 * Everything a tailoring run needs that belongs to a PERSON rather than to the app.
 *
 * These were optional overrides that fell back to reading two fixed files off disk. That fallback
 * WAS the single-user assumption: with it in place, a signed-in stranger tailors against whichever
 * resume happens to be on the server's filesystem. Required now, so a caller that has not resolved
 * whose resume this is fails to compile rather than silently using someone else's.
 */
export interface TailorInputs {
  baseTex: string;
  whitelist: string[];
  // the user's saved override, or DEFAULT_TAILOR_PROMPT. Note that a user CANNOT weaken the
  // no-fabrication guarantee by editing this: validator.ts runs the same checks against the same
  // whitelist regardless of what the prompt asks for.
  systemPrompt: string;
}

export interface TailorOptions {
  provider?: ClaudeProvider; // inject a fake in tests; the configured provider is built lazily otherwise
  feedback?: string; // free-text "request changes" tweak from the review-gate UI
  previousTex?: string; // the tex to revise when `feedback` is a tweak, not a from-scratch tailor
}

function buildInitialUserMessage(
  baseTex: string,
  whitelist: string[],
  jobDescription: string,
  feedback?: string,
  previousTex?: string
): string {
  const whitelistBlock = whitelist.join("\n");
  const parts = [
    `Job description:\n${jobDescription}`,
    `Skills whitelist (the ONLY keywords/technologies you may add):\n${whitelistBlock}`,
  ];

  if (previousTex) {
    // review-gate "request changes" path: revise the last tailored version per the user's
    // free-text feedback, not from scratch -- but the true base resume still goes along so
    // Claude can be held to the same never-remove/never-fabricate rules against the original
    parts.push(`Original base resume (for reference -- never regress past this):\n${baseTex}`);
    parts.push(`Current tailored resume to revise:\n${previousTex}`);
    parts.push(`User's requested change:\n${feedback ?? ""}`);
  } else {
    parts.push(`Base resume (LaTeX):\n${baseTex}`);
  }

  return parts.join("\n\n");
}

function buildRetryUserMessage(
  baseTex: string,
  whitelist: string[],
  jobDescription: string,
  lastTex: string,
  violations: TailorViolation[],
  feedback?: string,
  previousTex?: string
): string {
  const violationList = violations
    .map((v, i) => `${i + 1}. [${v.rule}]${v.line ? ` (line ${v.line})` : ""} ${v.message}`)
    .join("\n");

  const parts = [
    `Job description:\n${jobDescription}`,
    `Skills whitelist (the ONLY keywords/technologies you may add):\n${whitelist.join("\n")}`,
    `Base resume (LaTeX, for reference):\n${baseTex}`,
  ];

  // review-gate "request changes" retries must keep carrying the user's requested tweak (and the
  // tex it was requested against) alongside the violations -- otherwise a validation retry
  // silently reverts to plain from-base instructions and the user's feedback is lost
  if (previousTex) {
    parts.push(`Current tailored resume the user asked to revise:\n${previousTex}`);
    parts.push(`User's requested change:\n${feedback ?? ""}`);
  }

  parts.push(`Your previous response had problems -- do not repeat them:\n${lastTex}`);
  parts.push(`Fix these specific violations and return a corrected, complete resume:\n${violationList}`);

  return parts.join("\n\n");
}

// "removed-line x2, bullet-too-long" -- the rules that fired, deduped with counts, so the terminal
// says what went wrong without printing every message body
function summarizeRules(violations: TailorViolation[]): string {
  const counts = new Map<string, number>();
  for (const v of violations) counts.set(v.rule, (counts.get(v.rule) ?? 0) + 1);
  return [...counts]
    .map(([rule, count]) => (count > 1 ? `${rule} x${count}` : rule))
    .join(", ");
}

/**
 * Sends the base resume + job description to Claude, validates the result against the
 * code-enforced rules (Task 4), and retries (feeding back the specific violations) up to
 * MAX_RETRIES times. Never fabricates: any keyword Claude adds must be on the skills whitelist,
 * enforced both in the prompt and by the deterministic validator.
 */
export async function tailorResume(
  jobDescription: string,
  inputs: TailorInputs,
  opts: TailorOptions = {}
): Promise<TailorResult> {
  const log = logger("tailor");
  // narrow the posting to the job itself before anything else sees it: the prompt, the retry
  // messages, and the ATS keyword extraction all read from this. Benefits, pay bands, EEO
  // boilerplate and "about us" are not the job, and letting them through put terms like
  // "base pay" on the keyword list the résumé is scored against.
  const focusedDescription = extractRelevantSections(jobDescription);
  if (focusedDescription.length < jobDescription.length) {
    log(
      `posting narrowed to the role: ${formatCount(jobDescription.length)} → ` +
        `${formatCount(focusedDescription.length)} chars`
    );
  }

  const { baseTex, whitelist, systemPrompt } = inputs;
  // an empty whitelist is not a neutral default -- it means "nothing new may be claimed", which is
  // the strict end, not the loose one. Worth saying out loud because it looks like a no-op.
  if (whitelist.length === 0) {
    log("whitelist is empty · no new technology may be introduced at all");
  }

  // built lazily, and only when the caller didn't inject a fake, so tests never touch the
  // network, spawn the CLI, or require an API key
  const provider = opts.provider ?? getProvider();

  let userMessage = buildInitialUserMessage(
    baseTex,
    whitelist,
    focusedDescription,
    opts.feedback,
    opts.previousTex
  );

  let parsed: TailoredResume | null = null;
  let violations: TailorViolation[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    log(
      `attempt ${attempt + 1}/${MAX_RETRIES + 1} · prompt ${formatCount(userMessage.length)} chars`
    );
    log(`calling claude · ${PROVIDER} · ${MODEL}`);

    const elapsed = startTimer();
    // the CLI call runs over a minute; without a heartbeat the terminal looks hung
    parsed = await withHeartbeat(log, () =>
      provider({
        system: systemPrompt,
        user: userMessage,
        schema: TailoredResumeSchema,
      })
    );

    if (!parsed) {
      log(`✗ ${elapsed()} · response did not match the required structure`);
      // structured parse failed -- nothing to validate (there's no tex at all), so this is
      // reported under its own tag rather than "removed-line" (which specifically means a
      // section/bullet count shrank); treat like any other failed attempt and let the retry loop
      // try again (or exhaust) rather than crashing on a null tex
      violations = [
        {
          rule: "unparseable-response",
          message:
            "Your last response could not be parsed into the required structure. Return a complete, valid response with the required company, role, and tex fields.",
        },
      ];
      if (attempt >= MAX_RETRIES) break;
      userMessage = buildRetryUserMessage(
        baseTex,
        whitelist,
        focusedDescription,
        "(no tex returned)",
        violations,
        opts.feedback,
        opts.previousTex
      );
      continue;
    }

    log(
      `✓ ${elapsed()} · ${formatCount(parsed.tex.length)} chars · ${parsed.company} / ${parsed.role}`
    );

    violations = validateTailored(baseTex, parsed.tex, whitelist);
    log(
      violations.length === 0
        ? `validator: clean`
        : `validator: ${violations.length} violation(s) · ${summarizeRules(violations)}`
    );
    if (violations.length === 0 || attempt >= MAX_RETRIES) break;

    log(`retrying with the violations fed back`);
    userMessage = buildRetryUserMessage(
      baseTex,
      whitelist,
      focusedDescription,
      parsed.tex,
      violations,
      opts.feedback,
      opts.previousTex
    );
  }

  if (!parsed) {
    // every attempt (including retries) failed to parse -- this is a hard failure the API route
    // surfaces as a 502, not a violations-with-warnings result
    throw new Error("Claude did not return a parseable resume after all retries");
  }

  const report = buildReport(focusedDescription, baseTex, parsed.tex, whitelist);
  log(
    `ATS ${report.scoreBefore} → ${report.scoreAfter} · ${report.matchedAfter.length}/${report.keywords.length} keywords matched` +
      (report.fabricatedAdded.length > 0
        ? ` · ${report.fabricatedAdded.length} possible fabrication(s) flagged`
        : "")
  );

  return {
    tex: parsed.tex,
    company: parsed.company,
    role: parsed.role,
    violations,
    report,
  };
}
