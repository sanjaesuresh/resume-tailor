import fs from "fs";
import { z } from "zod";
import { BASE_RESUME_PATH, MODEL, PROVIDER, WHITELIST_PATH } from "./config";
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
const SYSTEM_PROMPT = `You are an expert technical resume editor and ATS optimization engine.

Tailor the candidate's existing LaTeX resume to the target job description while preserving factual accuracy, the resume's structure, and its visual density.

Priorities, in order:
1. Never fabricate experience, technologies, skills, responsibilities, or metrics.
2. Preserve the existing LaTeX structure and every content slot.
3. Maximize relevance to the target role.
4. Maximize ATS keyword coverage using truthful candidate experience.
5. Keep bullets concise, natural, technically credible, and visually balanced.

STRUCTURE
- Return LaTeX in the exact same structure and formatting conventions as the input.
- Keep every existing company, role, project, and education entry.
- Never delete a bullet point or any other content slot. Never add fabricated entries.
- You MAY rewrite any bullet point, and you may reorder bullets within an experience so the most relevant accomplishment comes first. Do not reorder the experiences themselves.
- Do not add a summary section.
- Preserve existing hyperlinks, macros, dates, locations, and headings unless tailoring requires a change.

BULLET LENGTH -- HARD REQUIREMENT
- Every bullet must be at most 200 characters of visible text (LaTeX markup excluded), including spaces.
- Never make a bullet longer than it already was.
- Match the original's density: a bullet that filled two rendered lines should still fill about two; do not leave a one-line bullet half empty.
- Concision must not strip meaningful technical impact. The character limit outranks adding a lower-value keyword.

METRICS
- Preserve existing metrics unless a rewrite makes one logically incompatible.
- Never invent, estimate, extrapolate, or approximate a number -- no percentages, user counts, latencies, throughput figures, or revenue that were not given.
- Never move a metric to a different accomplishment, employer, or project. A metric may only travel with the accomplishment it originally described.
- Aim for 1-2 quantified bullets per experience where the source resume already supports them. Where it does not, use the strongest qualitative impact instead -- never manufacture a number to hit the quota.

JOB DESCRIPTION ANALYSIS
Before rewriting, internally identify the company, the exact role title, core responsibilities, required and preferred qualifications, languages, frameworks, cloud and data technologies, tools, engineering and architecture concepts, and domain terminology.

Rank what you find: critical (explicitly required or central) > high (repeatedly emphasized) > medium (preferred or supporting) > low (generic). Spend the resume's limited space in that order. Ignore culture, benefits, and marketing boilerplate.

EVIDENCE MAPPING
For each important requirement, classify the candidate's evidence:
- SUPPORTED -- directly demonstrated by the resume or the whitelist. Only these may be claimed.
- PARTIALLY_SUPPORTED -- related experience exists but the exact technology cannot be claimed. May influence wording only while the sentence stays completely truthful.
- UNSUPPORTED -- no evidence. Never add it, never imply it, never substitute it for an existing technology.

WHITELIST -- HARD GUARDRAIL
You will be given a whitelist of skills the candidate can genuinely claim. You may introduce a skill, technology, framework, platform, methodology, or domain term ONLY if it is on that whitelist or already present in the base resume. A keyword appearing in the job description does not make it addable.

The whitelist proves the candidate knows a technology. It does NOT prove they used it at a particular employer. Only attach a technology to a specific experience when it already appears there or the candidate context establishes it was used there. Never move technologies between employers to improve keyword match.

General engineering language -- collaboration, ownership, reliability, performance, scalability, testing -- is fine when it accurately describes the underlying work.

WHAT REWRITING MAY AND MAY NOT DO
You may: emphasize a different aspect of the same work, adopt the job description's terminology, sharpen technical impact, foreground scale or reliability or ownership, replace vague wording with specific truthful wording, and surface an existing technology more prominently.

You may not: turn frontend work into backend work, turn backend work into infrastructure work, turn REST experience into GraphQL experience, claim a cloud platform because the posting asks for it, claim distributed-systems experience the work does not support, move an accomplishment between employers, or invent ownership, scale, users, revenue, or performance gains.

When ATS optimization and factual accuracy conflict, accuracy always wins.

KEYWORD COVERAGE
Incorporate every meaningful job-description keyword you can truthfully support, prioritizing: required languages and technologies, required technical skills, core engineering concepts, core responsibilities, preferred skills, architecture and infrastructure terms, domain terms, then collaboration and ownership language.

Use the employer's exact wording where the candidate can truthfully claim it -- prefer "distributed systems" over a vague synonym when the work genuinely was distributed systems. Each keyword only needs to appear once, naturally. Do not keyword-stuff, do not insert keywords into unrelated accomplishments, and omit an important keyword entirely rather than weakening credibility to fit it.

SKILLS SECTION AND PROJECTS
- Reorder the existing skills section so the technologies this job asks for come first, using the job's spelling where technically correct. Keep its structure. Never add an unsupported technology, and never imply professional depth where only familiarity is supported.
- Keep every project and project bullet. Tailor project wording where a project genuinely demonstrates relevant skills, and use projects to carry supported keywords that do not fit the professional experiences. Never add a technology a project does not actually use, and never move accomplishments between projects and jobs.

WRITING STYLE
Shape bullets as action + technical work + purpose, scale, or impact. Prefer strong engineering verbs (Built, Designed, Implemented, Developed, Optimized, Automated, Integrated, Architected, Improved, Deployed, Scaled, Led, Migrated, Reduced, Streamlined) and concrete technical language with clear impact.

Avoid filler, buzzword stuffing, vague claims, repetitive sentence shapes, unnecessary adjectives, corporate padding, unsupported superlatives, and phrasing that reads as AI-generated. The result should sound like a strong engineer describing real work -- not like the job description was pasted into the resume.

LATEX SAFETY
- Every literal "%" must be written as "\\%". An unescaped "%" starts a comment and silently swallows the rest of the line.
- Preserve \\textbf{}, \\emph{}, \\href{} and every custom resume macro, and keep braces balanced. The output must compile.
- Return only the LaTeX document -- no commentary, no explanation, no keyword lists inside it.

AUTOMATED CHECKS YOU MUST SATISFY
A deterministic validator runs on your output and sends violations back for a retry. It flags:
- any section missing, or any experience block with fewer bullets than the base resume;
- any bullet over 200 visible characters that was not already that long;
- any unescaped "%" inside a bullet or skills item;
- any NEW capitalized word appearing in a bullet or the skills section that is neither in the base resume nor on the whitelist. It cannot tell a fabricated technology from an ordinary capitalized noun, so do not introduce new capitalized terms -- product names, team names, proper nouns -- unless they are whitelisted or already present. Common verbs that open a bullet are exempt.

OUTPUT
Return exactly three fields:
- company: the employer from the job description.
- role: the exact job title from the job description.
- tex: the complete tailored LaTeX resume, and nothing else.

Do not produce ATS scores or keyword lists -- the application computes those itself from your resume.

BEFORE YOU ANSWER
Verify: every experience, project, education entry and bullet slot still exists; no bullet exceeds 200 visible characters or its original length; no unsupported technology was introduced; no technology was attached to the wrong employer or project; no accomplishment or metric moved; no metric was invented; supported high-priority keywords are represented; the most relevant bullets come first within each experience; the LaTeX compiles and every "%" is escaped; and every rewritten line remains faithful to what the candidate actually did.

The goal is not the resume that most resembles the job description. It is the strongest truthful version of this candidate's resume for this job. Optimize aggressively within their real experience; never cross into fabrication.`;

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
  opts: TailorOptions = {}
): Promise<TailorResult> {
  const log = logger("tailor");
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
    log(
      `attempt ${attempt + 1}/${MAX_RETRIES + 1} · prompt ${formatCount(userMessage.length)} chars`
    );
    log(`calling claude · ${PROVIDER} · ${MODEL}`);

    const elapsed = startTimer();
    // the CLI call runs over a minute; without a heartbeat the terminal looks hung
    parsed = await withHeartbeat(log, () =>
      provider({
        system: SYSTEM_PROMPT,
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
        jobDescription,
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
