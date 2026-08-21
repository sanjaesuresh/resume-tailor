// code-enforced no-fabrication safety net for the Claude-tailored resume: every rule here is a
// hard, deterministic check (no LLM judgment) so a violation can be fed straight back to Claude
// for a retry. Consumes stripLatex (Task 3) to compare/measure the visible text an ATS or human
// would actually read, never the raw LaTeX source.
import { stripLatex, expandWhitelist, stripTokenBoundaryPunctuation } from "./ats";

export type Rule =
  | "removed-line"
  | "bullet-too-long"
  | "unescaped-percent"
  | "non-whitelisted-keyword";

export interface Violation {
  rule: Rule;
  message: string;
  line?: number;
}

export interface ValidatorOptions {
  // the résumé item macro (e.g. "resumeItem" for the real template) -- exposed as an option so
  // tests can exercise the parser against simplified fixtures without the full Jake's-Resume boilerplate
  bulletMacro?: string;
}

// the real template's bullet-item macro (see assets/base-resume.sample.tex: \resumeItem{...})
const DEFAULT_BULLET_MACRO = "resumeItem";
const MAX_BULLET_LENGTH = 200;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 1-indexed line number for a character offset -- used so violations can point Claude at the
// exact line to fix on retry
function lineNumberAt(tex: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < tex.length; i++) {
    if (tex[i] === "\n") line++;
  }
  return line;
}

interface MacroInvocation {
  start: number; // index of the leading backslash
  end: number; // index just after the matching closing brace
  content: string; // text between the (outermost) braces, braces excluded
}

// finds every `\macroName{...}` invocation in `tex`, resolving the closing brace by counting
// nested-brace depth rather than a naive regex -- bullet content routinely nests other macros
// (e.g. `\resumeItem{Built \textbf{Python} services}`), so a `[^}]*`-style match would stop at
// the first inner `}` and truncate the real content
function findMacroInvocations(tex: string, macroName: string): MacroInvocation[] {
  const invocations: MacroInvocation[] = [];
  const pattern = new RegExp(`\\\\${escapeRegExp(macroName)}\\*?\\s*\\{`, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(tex))) {
    const contentStart = match.index + match[0].length;
    let depth = 1;
    let i = contentStart;
    while (i < tex.length && depth > 0) {
      if (tex[i] === "{") depth++;
      else if (tex[i] === "}") depth--;
      i++;
    }
    // i now sits just after the matching closing brace (or end-of-string if braces are unbalanced)
    invocations.push({ start: match.index, end: i, content: tex.slice(contentStart, i - 1) });
    // resume scanning after this whole invocation so nested content can't be re-matched as its own macro
    pattern.lastIndex = i;
  }

  return invocations;
}

interface Section {
  name: string;
  start: number; // start of section body (just after `\section{Name}`)
  end: number; // start of the next `\section{...}` heading, or end of tex
}

// segments a tex source by `\section{Name}` headings so bullet/removal checks can be scoped per
// section (a bullet moved between sections would otherwise look like a same-count no-op)
function findSections(tex: string): Section[] {
  const pattern = /\\section\*?\s*\{([^}]*)\}/g;
  const headings: { name: string; headingStart: number; contentStart: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(tex))) {
    headings.push({
      name: match[1].trim(),
      headingStart: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  return headings.map((h, i) => ({
    name: h.name,
    start: h.contentStart,
    end: i + 1 < headings.length ? headings[i + 1].headingStart : tex.length,
  }));
}

// groups an ordered list of bullet invocations into "blocks" (one per job/project entry) by
// treating a run of bullets as the same block as long as only whitespace separates them; any
// other content between two bullets (a \resumeSubheading, list-environment wrapper, etc.) is a
// block boundary. This avoids needing a second macro-name option for the block-heading command --
// the real template's \resumeSubheading, \resumeProjectHeading, etc. are naturally "other content".
function groupBulletsIntoBlocks(tex: string, invocations: MacroInvocation[]): number[] {
  const counts: number[] = [];
  let prevEnd = -1;

  for (const inv of invocations) {
    const isSameBlock = prevEnd !== -1 && tex.slice(prevEnd, inv.start).trim() === "";
    if (isSameBlock) {
      counts[counts.length - 1] += 1;
    } else {
      counts.push(1);
    }
    prevEnd = inv.end;
  }

  return counts;
}

// removed-line: every section in the base must still exist in the tailored resume, and every
// bullet-count block within a matching section must not shrink. Bullets may be reworded/reordered
// freely (only counts are compared, never text) -- this catches Claude silently dropping a whole
// responsibility rather than rephrasing it
export function checkRemovedLines(
  baseTex: string,
  tailoredTex: string,
  options: ValidatorOptions = {}
): Violation[] {
  const bulletMacro = options.bulletMacro ?? DEFAULT_BULLET_MACRO;
  const violations: Violation[] = [];

  const baseSections = findSections(baseTex);
  const tailoredSections = findSections(tailoredTex);
  const tailoredSectionByName = new Map(tailoredSections.map((s) => [s.name, s]));

  const baseBullets = findMacroInvocations(baseTex, bulletMacro);
  const tailoredBullets = findMacroInvocations(tailoredTex, bulletMacro);

  for (const baseSection of baseSections) {
    const tailoredSection = tailoredSectionByName.get(baseSection.name);
    if (!tailoredSection) {
      violations.push({
        rule: "removed-line",
        message: `Section "${baseSection.name}" is missing from the tailored resume`,
      });
      continue;
    }

    const baseSectionBullets = baseBullets.filter(
      (b) => b.start >= baseSection.start && b.start < baseSection.end
    );
    const tailoredSectionBullets = tailoredBullets.filter(
      (b) => b.start >= tailoredSection.start && b.start < tailoredSection.end
    );

    const baseBlockCounts = groupBulletsIntoBlocks(baseTex, baseSectionBullets);
    const tailoredBlockCounts = groupBulletsIntoBlocks(tailoredTex, tailoredSectionBullets);

    baseBlockCounts.forEach((baseCount, blockIndex) => {
      const tailoredCount = tailoredBlockCounts[blockIndex] ?? 0;
      if (tailoredCount < baseCount) {
        violations.push({
          rule: "removed-line",
          message:
            `Section "${baseSection.name}" block ${blockIndex + 1} has ${tailoredCount} ` +
            `bullet(s) in the tailored resume but ${baseCount} in the base resume`,
        });
      }
    });
  }

  return violations;
}

// bullet-too-long: the visible (LaTeX-stripped) text of a bullet must be at most 200 characters
// UNLESS it was already over that limit in the base resume -- the system prompt forbids Claude
// from ever shortening an existing line, so a pre-existing over-length bullet must be grandfathered
// rather than flagged forever (an unfixable violation would just burn every retry). Bullets are
// matched to their base counterpart by position (i-th bullet in document order): only a bullet
// that is BOTH over the limit AND longer than what it started as counts as tailoring's fault.
export function checkBulletTooLong(
  baseTex: string,
  tailoredTex: string,
  options: ValidatorOptions = {}
): Violation[] {
  const bulletMacro = options.bulletMacro ?? DEFAULT_BULLET_MACRO;
  const violations: Violation[] = [];

  const baseBulletLengths = findMacroInvocations(baseTex, bulletMacro).map(
    (inv) => stripLatex(inv.content).length
  );

  findMacroInvocations(tailoredTex, bulletMacro).forEach((inv, i) => {
    const visibleText = stripLatex(inv.content);
    if (visibleText.length <= MAX_BULLET_LENGTH) return;

    const baseLength = baseBulletLengths[i];
    if (baseLength !== undefined && visibleText.length <= baseLength) return; // grandfathered

    violations.push({
      rule: "bullet-too-long",
      message:
        `Bullet is ${visibleText.length} characters (max ${MAX_BULLET_LENGTH}): ` +
        `"${visibleText.slice(0, 80)}${visibleText.length > 80 ? "..." : ""}"`,
      line: lineNumberAt(tailoredTex, inv.start),
    });
  });

  return violations;
}

// unescaped-percent: a `%` compiles as "start LaTeX comment" unless escaped as `\%`, so any
// unescaped `%` mid-line (e.g. "reduced latency by 30%") would silently swallow the rest of that
// line when the resume is compiled. A prior version exempted any "%" preceded by whitespace to
// stop legitimate trailing comments in the (never-edited) preamble from being flagged -- but that
// exemption is a false-negative hole: "30 % across services" is exactly the shape a real resume
// bullet takes ("reduced X by 30 % across Y"), and it silently truncated the rest of the bullet in
// the compiled PDF with no compile error. The fix scopes the check to content Claude actually
// rewrites (bullet/item bodies, the same regions signal C in checkNonWhitelistedKeyword covers) --
// preamble/template scaffolding is never touched by tailoring (checkRemovedLines already guards
// structural changes elsewhere), so it doesn't need percent-checking, and within an editable body
// there is no such thing as a "deliberate" unescaped percent: every one is a defect.
export function checkUnescapedPercent(
  tailoredTex: string,
  options: ValidatorOptions = {}
): Violation[] {
  const bulletMacro = options.bulletMacro ?? DEFAULT_BULLET_MACRO;
  const violations: Violation[] = [];
  const lines = tailoredTex.split("\n");
  const flaggedLines = new Set<number>();

  // same two regions signal C scans: the bullet macro plus plain `\item{...}` bodies (the
  // Technical Skills section uses `\item`, not `\resumeItem`)
  const invocations = [
    ...findMacroInvocations(tailoredTex, bulletMacro),
    ...findMacroInvocations(tailoredTex, "item"),
  ];

  for (const inv of invocations) {
    // MacroInvocation doesn't track content's own start offset, only `end` (just after the
    // closing brace) and `content` itself -- derive it: content occupies
    // [contentStart, end - 1), so contentStart = end - 1 - content.length
    const contentStart = inv.end - 1 - inv.content.length;

    for (let i = 0; i < inv.content.length; i++) {
      if (inv.content[i] !== "%") continue;
      if (inv.content[i - 1] === "\\") continue; // escaped -- safe

      const lineNo = lineNumberAt(tailoredTex, contentStart + i);
      if (flaggedLines.has(lineNo)) continue; // one flag per offending line is enough to drive a retry
      flaggedLines.add(lineNo);
      violations.push({
        rule: "unescaped-percent",
        message: `Unescaped "%" on line ${lineNo}: "${(lines[lineNo - 1] ?? "").trim()}"`,
        line: lineNo,
      });
    }
  }

  return violations;
}

// tech-name-shaped tokens: letters/digits plus embedded '.', '+', '#' so names like "Node.js",
// "C++", "C#" survive as one token instead of being split apart. The boundary-punctuation strip
// afterward is what makes "...and GitHub Actions." tokenize as "Actions" rather than "Actions." --
// without it, a bullet ending in a tech name (extremely common resume phrasing) reads as a
// different, unknown term than the same whitelist entry appearing mid-sentence.
function tokenizeRaw(text: string): string[] {
  const raw = text.match(/[A-Za-z0-9][A-Za-z0-9+#.]*/g) || [];
  return raw.map(stripTokenBoundaryPunctuation).filter(Boolean);
}

// closed set of common resume-bullet opener verbs (past tense + gerund) -- the ONLY reason a
// sentence-initial capitalized word is exempt from signal C. A blanket "first word of sentence"
// exemption (round 1) was itself a false-negative hole: "Kubernetes orchestration reduced..." or
// "Terraform handled provisioning." fabricates a tech term that happens to open a sentence, and a
// positional exemption would wave it through with zero signals catching it. False positives here
// are cheap (Claude just retries with the violation listed); false negatives put an unclaimable
// skill on a real job application -- so exemptions must be an explicit, narrow whitelist of known
// non-tech openers, never inferred from position alone.
const RESUME_BULLET_OPENERS = new Set(
  [
    "Managed", "Managing",
    "Built", "Building",
    "Led", "Leading",
    "Developed", "Developing",
    "Deployed", "Deploying",
    "Designed", "Designing",
    "Implemented", "Implementing",
    "Improved", "Improving",
    "Created", "Creating",
    "Wrote", "Writing",
    "Architected", "Architecting",
    "Engineered", "Engineering",
    "Optimized", "Optimizing",
    "Reduced", "Reducing",
    "Increased", "Increasing",
    "Launched", "Launching",
    "Maintained", "Maintaining",
    "Migrated", "Migrating",
    "Refactored", "Refactoring",
    "Automated", "Automating",
    "Delivered", "Delivering",
    "Collaborated", "Collaborating",
    "Owned", "Owning",
    "Drove", "Driving",
    "Shipped", "Shipping",
    "Spearheaded", "Spearheading",
    "Streamlined", "Streamlining",
    "Integrated", "Integrating",
    "Established", "Establishing",
    "Coordinated", "Coordinating",
    "Analyzed", "Analyzing",
    "Researched", "Researching",
    "Tested", "Testing",
    "Debugged", "Debugging",
    "Scaled", "Scaling",
    "Partnered", "Partnering",
    "Mentored", "Mentoring",
    "Presented", "Presenting",
    "Authored", "Authoring",
    "Reviewed", "Reviewing",
    "Supported", "Supporting",
    "Enabled", "Enabling",
    "Achieved", "Achieving",
    "Generated", "Generating",
    "Produced", "Producing",
    "Directed", "Directing",
    "Oversaw", "Overseeing",
    "Executed", "Executing",
    "Founded", "Founding",
    "Introduced", "Introducing",
    "Resolved", "Resolving",
    "Simplified", "Simplifying",
    "Standardized", "Standardizing",
    "Transformed", "Transforming",
    "Upgraded", "Upgrading",
    "Validated", "Validating",
  ].map((w) => w.toLowerCase())
);

// non-whitelisted-keyword: any term that is new in the tailored resume (wasn't in the base,
// case-insensitively) and looks like a technology name must appear on the whitelist. This is the
// fabrication guard: Claude may rephrase, but may not invent skills.
//
// "Looks like a technology" is deliberately biased toward false positives over false negatives --
// a wrongly-flagged term just costs Claude a retry, while a missed one puts an unclaimable skill
// on a real job application. Three signals feed the check: (a) the template's own convention of
// bolding every skill/tech term via `\textbf{...}`, (b) shape -- a digit, an embedded dot
// (Node.js), or an ALL-CAPS acronym (REST, SQL) -- none of which a plain English word exhibits,
// and (c) capitalization anywhere in a bullet that isn't a known resume-bullet opener verb --
// most real tech proper nouns (Kubernetes, Terraform, MongoDB) are plain mixed-case prose that (a)
// and (b) would otherwise miss entirely. Signal (c) is scoped per-bullet (split into sentences on
// ". "/"! "/"? ") and exempts a sentence's first word ONLY when it's on the closed
// RESUME_BULLET_OPENERS list (see above) -- NOT merely because it's first. A positional-only
// exemption would itself be a false-negative hole ("Kubernetes orchestration reduced...", or a
// later sentence "Terraform handled provisioning."), since a fabricated tech term can just as
// naturally open a bullet or sentence as a verb can. Every other capitalized token, first-word or
// not, is treated as suspect, accepting the occasional false positive (a stray capitalized common
// noun, or a real but unlisted opener verb) as the safer failure mode.
export function checkNonWhitelistedKeyword(
  baseTex: string,
  tailoredTex: string,
  whitelist: string[],
  options: ValidatorOptions = {}
): Violation[] {
  const bulletMacro = options.bulletMacro ?? DEFAULT_BULLET_MACRO;
  const baseTokensLower = new Set(tokenizeRaw(stripLatex(baseTex)).map((t) => t.toLowerCase()));
  // expand whitelist entries into both the whole phrase AND its individual words (shared with
  // ats.ts's buildReport) -- a single-token comparison otherwise flags every word of a multi-word
  // whitelisted skill ("React Native" whitelisted still flags "React" and "Native" separately)
  const whitelistLower = expandWhitelist(whitelist);

  // strip `%` comments before scanning the tailored tex for macro invocations (signals A/C below).
  // findMacroInvocations is a plain regex/brace scan with no comment awareness, so without this a
  // macro sitting inside a commented-out (dead) line -- e.g. the template's commented-out MIT
  // attribution header -- still gets matched as if it were live content. The base token set (built
  // through stripLatex, which already strips comments) never sees that same dead text, so the
  // asymmetry made an unmodified resume's own boilerplate comments look like new fabricated terms.
  const tailoredTexNoComments = tailoredTex.replace(/(?<!\\)%.*$/gm, "");

  // signal A: terms the tailored resume bolds
  const boldedTokens = findMacroInvocations(tailoredTexNoComments, "textbf").flatMap((inv) =>
    tokenizeRaw(stripLatex(inv.content))
  );

  // signal B: tokens anywhere in the visible text that are unambiguously tech-shaped regardless
  // of bolding (digit, embedded dot, or an all-caps acronym)
  const shapeSignalTokens = tokenizeRaw(stripLatex(tailoredTexNoComments)).filter((token) => {
    const hasLetter = /[A-Za-z]/.test(token);
    const isAllCapsAcronym = hasLetter && token === token.toUpperCase() && token.length >= 2;
    return /\d/.test(token) || token.includes(".") || isAllCapsAcronym;
  });

  // signal C: capitalized tokens, except a sentence's first word when that word is on the
  // RESUME_BULLET_OPENERS whitelist -- catches Kubernetes/Terraform/MongoDB-style fabrications
  // introduced as plain prose (no bolding, no digits/dots/all-caps), including when the fabricated
  // term itself opens a bullet or a later sentence. Splitting on ". "/"! "/"? " scopes the opener
  // exemption to each sentence's own first word, not just the bullet's very first word.
  //
  // Scoped over both the bullet macro AND plain `\item` bodies: the real template's Technical
  // Skills section is a single `\item{...}` (not `\resumeItem{...}`), with each skill name sitting
  // in an unbolded second brace group (`\textbf{Category}{: Python, Java, ...}`) -- bulletMacro
  // alone would never see that section at all, leaving injected skills there undetectable.
  const capitalizedMidSentenceTokens = [
    ...findMacroInvocations(tailoredTexNoComments, bulletMacro),
    ...findMacroInvocations(tailoredTexNoComments, "item"),
  ].flatMap((inv) => {
    const sentences = stripLatex(inv.content).split(/(?<=[.!?])\s+/);
    return sentences.flatMap((sentence) =>
      tokenizeRaw(sentence).filter((token, i) => {
        if (!/^[A-Z]/.test(token)) return false;
        // narrow, explicit exemption -- position alone is never sufficient (see rationale above)
        if (i === 0 && RESUME_BULLET_OPENERS.has(token.toLowerCase())) return false;
        return true;
      })
    );
  });

  const violations: Violation[] = [];
  const flagged = new Set<string>();

  for (const token of [...boldedTokens, ...shapeSignalTokens, ...capitalizedMidSentenceTokens]) {
    const lower = token.toLowerCase();
    if (baseTokensLower.has(lower)) continue; // not new
    if (flagged.has(lower)) continue; // already reported once
    if (whitelistLower.has(lower)) continue;

    flagged.add(lower);
    violations.push({
      rule: "non-whitelisted-keyword",
      message: `New term "${token}" appears in the tailored resume but is not on the approved keyword whitelist`,
    });
  }

  return violations;
}

// runs all four code-enforced rules and returns every violation found -- an empty array means the
// tailored tex is safe to show the user as-is; a non-empty array is fed back to Claude (Task 6)
// as retry instructions
export function validateTailored(
  baseTex: string,
  tailoredTex: string,
  whitelist: string[],
  options: ValidatorOptions = {}
): Violation[] {
  return [
    ...checkRemovedLines(baseTex, tailoredTex, options),
    ...checkBulletTooLong(baseTex, tailoredTex, options),
    ...checkUnescapedPercent(tailoredTex, options),
    ...checkNonWhitelistedKeyword(baseTex, tailoredTex, whitelist, options),
  ];
}
