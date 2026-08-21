// pure, dependency-free ATS keyword extraction + reporting -- no imports from other lib
// modules so this stays trivially testable and reusable by the validator/tailoring service.

// generic English function words plus common resume/JD filler that would otherwise
// dominate frequency counts (e.g. "team", "role") without being an actual skill/keyword
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "he", "her", "him", "his", "i", "if", "in", "is", "it", "its", "of",
  "on", "or", "our", "she", "that", "the", "their", "them", "they", "this",
  "to", "was", "we", "were", "will", "with", "you", "your", "not", "no", "yes",
  "can", "could", "should", "would", "do", "does", "did", "done", "been",
  "being", "who", "what", "which", "when", "where", "why", "how", "all", "any",
  "both", "each", "few", "more", "most", "other", "some", "such", "only",
  "own", "same", "so", "than", "too", "very", "just", "now", "us", "about",
  "into", "over", "under", "up", "down", "out", "off", "again", "further",
  "there", "here", "these", "those", "am", "or",
  // resume/job-posting filler that reads as "generic requirement", not a real keyword
  "team", "role", "strong", "looking", "ideal", "candidate", "experience",
  "environment", "well", "works", "using", "use", "used", "skills", "skill",
  "solid", "familiarity", "requires", "required", "practices", "work",
  "years", "year", "plus", "including", "etc",
]);

// fixed dictionary of multi-word tech phrases -- deterministic and dependency-free per the
// brief; these count as keywords the moment they appear, regardless of raw frequency
const TECH_PHRASES = [
  "machine learning", "deep learning", "unit testing", "integration testing",
  "test driven development", "continuous integration", "continuous deployment",
  "ci/cd", "object oriented", "data structures", "software engineering",
  "full stack", "front end", "back end", "version control", "rest api",
  "restful api", "cloud computing", "data science", "artificial intelligence",
  "natural language processing", "computer vision", "agile development",
  "project management", "distributed systems", "microservices architecture",
];

const KEYWORD_CAP = 60;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// custom boundary check instead of regex `\b`: tech terms often start/end with non-alphanumeric
// chars (C++, CI/CD), and `\b` only fires at a word/non-word transition, so it would silently
// fail to match "c++ " (both '+' and the following space are non-word chars, no transition)
function boundaryRegex(phrase: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(phrase)}(?![a-z0-9])`, "i");
}

function countOccurrences(text: string, phrase: string): number {
  const matches = text.match(new RegExp(boundaryRegex(phrase).source, "gi"));
  return matches ? matches.length : 0;
}

function containsWord(text: string, phrase: string): boolean {
  return boundaryRegex(phrase).test(text);
}

// splits on tech-friendly word chars (keeps things like "c++", "node.js", "ci/cd" intact)
function tokenize(loweredText: string): string[] {
  return loweredText.match(/[a-z0-9][a-z0-9+#./-]*/g) || [];
}

/**
 * Extracts a deduplicated, ranked list of candidate ATS keywords from a job description.
 * Combines: (a) known tech phrases + capitalized/proper-noun-looking tokens (counted even
 * on a single mention, since a JD only needs to say "Kubernetes" once), and (b) generic
 * unigrams/bigrams that repeat (a frequency floor keeps one-off filler words out).
 */
export function extractKeywords(jobDescription: string): string[] {
  const lowered = jobDescription.toLowerCase();
  const counts = new Map<string, number>();
  const bump = (key: string, by = 1) => counts.set(key, (counts.get(key) || 0) + by);

  // (a) fixed tech-phrase dictionary
  const matchedPhrases = new Set<string>();
  for (const phrase of TECH_PHRASES) {
    const occurrences = countOccurrences(lowered, phrase);
    if (occurrences > 0) {
      bump(phrase, occurrences);
      matchedPhrases.add(phrase);
    }
  }

  // build a set of fragments from matched phrases; suppress these as separate token keywords.
  // e.g., when "ci/cd" is matched, "ci" and "cd" (the non-alphanumeric-separated parts)
  // should not be added as separate capitalized tokens.
  const phraseFragments = new Set<string>();
  for (const phrase of matchedPhrases) {
    const fragments = phrase.split(/[^a-z0-9]+/).filter((f) => f.length >= 2);
    for (const frag of fragments) {
      phraseFragments.add(frag);
    }
  }

  // (a) capitalized tokens in the ORIGINAL text (before lowering) look like proper nouns /
  // tech names -- e.g. "Python", "Kubernetes" -- and count even if mentioned only once.
  // skip tokens that are fragments of already-matched phrases (e.g., "ci", "cd" when
  // "ci/cd" has already been matched).
  const capitalMatches = jobDescription.match(/\b[A-Z][A-Za-z0-9]{1,}\b/g) || [];
  for (const raw of capitalMatches) {
    const word = raw.toLowerCase();
    if (STOPWORDS.has(word) || word.length < 2) continue;
    if (phraseFragments.has(word)) continue;
    bump(word);
  }

  // (b) frequent non-stopword unigrams -- require a repeat so generic prose doesn't flood the list
  const rawWords = tokenize(lowered);
  const unigramCounts = new Map<string, number>();
  for (const w of rawWords) {
    if (STOPWORDS.has(w) || w.length < 2 || /^\d+$/.test(w)) continue;
    unigramCounts.set(w, (unigramCounts.get(w) || 0) + 1);
  }
  for (const [w, c] of unigramCounts) {
    if (c >= 2) bump(w, c);
  }

  // (b) frequent non-stopword bigrams, built from the unfiltered token stream so adjacency
  // reflects the real sentence (filtering first would join unrelated words together)
  const bigramCounts = new Map<string, number>();
  for (let i = 0; i < rawWords.length - 1; i++) {
    const first = rawWords[i];
    const second = rawWords[i + 1];
    if (STOPWORDS.has(first) || STOPWORDS.has(second)) continue;
    if (first.length < 2 || second.length < 2) continue;
    const bigram = `${first} ${second}`;
    bigramCounts.set(bigram, (bigramCounts.get(bigram) || 0) + 1);
  }
  for (const [bg, c] of bigramCounts) {
    if (c >= 2) bump(bg, c);
  }

  // rank by frequency (stable sort keeps deterministic ordering for ties), cap the list,
  // and defensively drop anything that slipped through as a bare stopword
  return Array.from(counts.entries())
    .filter(([kw]) => !STOPWORDS.has(kw))
    .sort((a, b) => b[1] - a[1])
    .slice(0, KEYWORD_CAP)
    .map(([kw]) => kw);
}

// commands whose argument is structural (environment name, length, package name) rather
// than resume prose -- drop them entirely, argument included, before generic unwrapping
const STRUCTURAL_COMMANDS =
  "begin|end|newcommand|renewcommand|documentclass|usepackage|setlength|addtolength|" +
  "pagestyle|fancyhf|fancyfoot|urlstyle|newlength|titleformat|input";

/**
 * Reduces a .tex source to the plain text an ATS parser would actually see: comments gone,
 * LaTeX commands gone but their argument text kept (textbf/resumeItem-style macros wrap real
 * resume content), escaped special characters restored, braces/backslashes stripped.
 */
export function stripLatex(tex: string): string {
  let text = tex;

  // drop `%` comments (a `%` not preceded by `\`) through end of line -- LaTeX-only, never content
  text = text.replace(/(?<!\\)%.*$/gm, "");

  // unescape literal special characters LaTeX escapes for rendering (e.g. "30\%" -> "30%")
  text = text.replace(/\\([%&_$#{}])/g, "$1");

  // structural commands: remove the command AND its argument (environment/package names etc.)
  text = text.replace(
    new RegExp(`\\\\(?:${STRUCTURAL_COMMANDS})\\*?(?:\\[[^\\]]*\\])?\\{[^{}]*\\}`, "g"),
    ""
  );

  // remaining macros (textbf, resumeItem, href, emph, ...): strip the command name + any
  // [optional] arg, but leave the following {argument} braces/text for the next step
  text = text.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, "");

  // braces are now just grouping, not content -- drop them, keep the text they wrapped
  text = text.replace(/[{}]/g, "");

  // collapse line-continuation "\\" and clean up any stray backslashes left over
  text = text.replace(/\\\\/g, " ").replace(/\\/g, "");

  // normalize whitespace so newlines/tabs from the source don't affect word-boundary matching
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

export interface AtsReport {
  keywords: string[];
  matchedBefore: string[];
  matchedAfter: string[];
  scoreBefore: number;
  scoreAfter: number;
  missing: string[];
  missingNotClaimable: string[];
}

/**
 * Builds a before/after ATS match report: how many extracted JD keywords show up in the
 * base resume vs. the tailored one, and which still-missing keywords are safe to add (i.e.
 * backed by the whitelist) vs. should never be fabricated (missingNotClaimable).
 */
export function buildReport(
  jobDescription: string,
  baseTex: string,
  tailoredTex: string,
  whitelist: string[]
): AtsReport {
  const keywords = extractKeywords(jobDescription);
  const baseText = stripLatex(baseTex);
  const tailoredText = stripLatex(tailoredTex);
  const whitelistLower = new Set(whitelist.map((w) => w.toLowerCase()));

  const matchedBefore = keywords.filter((k) => containsWord(baseText, k));
  const matchedAfter = keywords.filter((k) => containsWord(tailoredText, k));

  const scoreBefore = keywords.length
    ? Math.round((matchedBefore.length / keywords.length) * 100)
    : 0;
  const scoreAfter = keywords.length
    ? Math.round((matchedAfter.length / keywords.length) * 100)
    : 0;

  const missing = keywords.filter((k) => !matchedAfter.includes(k));
  // keywords the résumé can't honestly back up: missing from the tailored text AND not on the
  // whitelist -- tailoring must never fabricate these in, so surfacing them is the whole point
  const missingNotClaimable = missing.filter((k) => !whitelistLower.has(k));

  return {
    keywords,
    matchedBefore,
    matchedAfter,
    scoreBefore,
    scoreAfter,
    missing,
    missingNotClaimable,
  };
}
