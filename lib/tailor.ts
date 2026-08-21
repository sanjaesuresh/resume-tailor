import fs from "fs";
import { z } from "zod";
import { BASE_RESUME_PATH, WHITELIST_PATH } from "./config";
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

export interface TailorOptions {
  provider?: ClaudeProvider; // inject a fake in tests; the configured provider is built lazily otherwise
  baseTex?: string; // override the on-disk base resume (tests)
  whitelist?: string[]; // override the on-disk whitelist (tests)
  feedback?: string; // free-text "request changes" tweak from the review-gate UI
  previousTex?: string; // the tex to revise when `feedback` is a tweak, not a from-scratch tailor
}

// the user's proven tailoring rules, in the exact order the brief specifies: (1) role, (2) the
// editing rules verbatim in spirit, (3) the no-fabrication guardrail, (4) company/role extraction.
// This is the one place these rules live -- getting them right here is the point of this module.
const SYSTEM_PROMPT = `You are an expert resume editor. Your job is to rewrite a candidate's LaTeX resume so it matches a target job description as closely as possible, to maximize keyword match with Applicant Tracking Systems (ATS).

Follow these rules exactly:
- Respond with LaTeX in the exact same format as the input resume.
- Keep all existing work experiences.
- NEVER remove or shorten any lines. Only change keywords and points.
- Rearranging work highlights (the order of bullet points within a job) is allowed.
- Modify key technologies mentioned in bullet points to match the job description.
- Do not add a summary section.
- Keep every bullet point at or under 200 characters (including spaces) where it already is. Never make an existing bullet point longer than it already was.
- Any literal "%" character must be written as "\\%" (an unescaped "%" starts a LaTeX comment and breaks compilation).
- Add every job-description keyword you can truthfully add, to maximize ATS keyword match.

Guardrail -- never violate this: you will be given a whitelist of skills the candidate can genuinely claim. You may only add a keyword or technology to the resume if it appears on that whitelist. If a job-description keyword is not on the whitelist, leave it out entirely -- never claim a skill the candidate does not have, even if adding it would improve the ATS match.

You must also identify the company name and the role/job title from the job description, for the application tracker.`;

// the whitelist file is markdown: a "# ..." header, a short prose blurb explaining the rules,
// blank lines, then one skill per line. Skills are short noun phrases (rarely more than a
// handful of words); the intro prose reads as full sentences, so a word-count cutoff separates
// "commentary to skip" from "skill to keep" without needing the prose to follow any stricter format
const WHITELIST_COMMENT_MAX_WORDS = 6;

function parseWhitelist(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0) // blank lines
    .filter((line) => !line.startsWith("#")) // markdown header
    .filter((line) => line.split(/\s+/).length <= WHITELIST_COMMENT_MAX_WORDS); // intro prose
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

/**
 * Sends the base resume + job description to Claude, validates the result against the
 * code-enforced rules (Task 4), and retries (feeding back the specific violations) up to
 * MAX_RETRIES times. Never fabricates: any keyword Claude adds must be on the skills whitelist,
 * enforced both in the prompt and by the deterministic validator.
 */
export async function tailorResume(
  jobDescription: string,
  opts: TailorOptions = {}
): Promise<TailorResult> {
  const baseTex = opts.baseTex ?? fs.readFileSync(BASE_RESUME_PATH, "utf-8");
  const whitelist = opts.whitelist ?? parseWhitelist(fs.readFileSync(WHITELIST_PATH, "utf-8"));
  // built lazily, and only when the caller didn't inject a fake, so tests never touch the
  // network, spawn the CLI, or require an API key
  const provider = opts.provider ?? getProvider();

  let userMessage = buildInitialUserMessage(
    baseTex,
    whitelist,
    jobDescription,
    opts.feedback,
    opts.previousTex
  );

  let parsed: TailoredResume | null = null;
  let violations: TailorViolation[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    parsed = await provider({
      system: SYSTEM_PROMPT,
      user: userMessage,
      schema: TailoredResumeSchema,
    });

    if (!parsed) {
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
        jobDescription,
        "(no tex returned)",
        violations,
        opts.feedback,
        opts.previousTex
      );
      continue;
    }

    violations = validateTailored(baseTex, parsed.tex, whitelist);
    if (violations.length === 0 || attempt >= MAX_RETRIES) break;

    userMessage = buildRetryUserMessage(
      baseTex,
      whitelist,
      jobDescription,
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

  const report = buildReport(jobDescription, baseTex, parsed.tex, whitelist);

  return {
    tex: parsed.tex,
    company: parsed.company,
    role: parsed.role,
    violations,
    report,
  };
}
