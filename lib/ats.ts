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
  // ordinary English that survives the capitalized-token rule by opening a sentence or a bullet
  // ("One of our...", "Everything we ship...") -- reported as bogus keywords from a real posting
  "one", "two", "three", "everything", "anything", "something", "everyone",
  "someone", "everywhere", "may", "might", "must", "also", "across", "within",
  "while", "through", "before", "after", "during", "per", "via", "like",
  "make", "makes", "making", "made", "help", "helps", "helping", "new", "next",
  "best", "better", "great", "good", "high", "level", "time", "times", "day",
  "days", "week", "weeks", "month", "months", "every", "many", "much", "able",
  "want", "wants", "need", "needs", "get", "gets", "give", "gives", "take",
  "takes", "come", "comes", "join", "joining", "please", "thank", "thanks",
  // compensation / benefits / legal boilerplate -- the section filter in jobtext.ts removes most
  // of it, but a stray mention inside a kept section should still never rank as a skill
  "base", "pay", "salary", "salaries", "compensation", "bonus", "equity",
  "benefits", "perks", "insurance", "dental", "vision", "medical", "range",
  "offer", "offers", "apply", "application", "applicants", "applicant",
  "employer", "employment", "employee", "employees", "opportunity", "eligible",
  "company", "companies", "business", "people", "world", "mission", "culture",
  "values", "diverse", "diversity", "inclusive", "inclusion", "regardless",
  // contraction tails -- the tokenizer splits on the apostrophe, so "we've"/"you'll"/"don't"
  // leave "ve"/"ll"/"don" behind, and they repeat often enough to rank
  "ve", "ll", "re", "don", "doesn", "isn", "aren", "wasn", "weren", "won",
  "didn", "couldn", "shouldn", "wouldn", "hasn", "haven", "let", "lets",
  "folks", "today", "others", "often", "first", "second", "feel", "set",
  "my", "me", "own", "yours", "ours",
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

// lowercase terms that are real ATS keywords but rarely appear capitalized, so the proper-noun
// evidence test below would otherwise discard them. Deliberately small and technical -- this is a
// dictionary of things a résumé can claim, not a general vocabulary.
const TECH_TERMS = new Set([
  "backend", "frontend", "fullstack", "full-stack", "api", "apis", "sdk",
  "database", "databases", "sql", "nosql", "cloud", "devops", "ci", "cd",
  "microservices", "serverless", "containers", "orchestration", "kubernetes",
  "docker", "infrastructure", "pipeline", "pipelines", "deployment", "testing",
  "debugging", "monitoring", "observability", "latency", "throughput",
  "scalability", "scalable", "distributed", "concurrency", "caching",
  "authentication", "authorization", "encryption", "security", "compiler",
  "runtime", "algorithms", "networking", "performance", "reliability",
  "accessibility", "typescript", "javascript", "python", "java", "golang",
  "react", "graphql", "rest", "grpc", "postgres", "postgresql", "redis",
]);

const KEYWORD_CAP = 60;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// boundary punctuation that can wrap a token/whitelist entry without being part of the term
// itself: a trailing sentence-ending period/comma/semicolon/colon (e.g. "...and GitHub Actions.")
// or closing paren, or a leading opening paren (e.g. an abbreviation gloss "(TDD)"). Stripped only
// at the very edges, and repeatedly (in case of doubled-up punctuation like a period inside a
// closing quote), so internal, meaning-bearing punctuation always survives: "Node.js"/"React.js"
// keep their dot (it's not at either edge), "C++"/"C#" are untouched (those symbols aren't in this
// strip set), "CI/CD" is untouched (the tokenizers below never produce a token with a trailing
// slash), and ".NET" keeps its leading dot (the strip set's only leading char is "("). Shared by
// both validator.ts's token path and this file's tokenize()/expandWhitelist so the two stay
// symmetric -- a term normalized one way but not the other is exactly how the trailing-period bug
// (a false "non-whitelisted-keyword" on any bullet ending in a tech name) happened in the first place.
export function stripTokenBoundaryPunctuation(token: string): string {
  return token.replace(/^\(+/, "").replace(/[.,;:)]+$/, "");
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

// splits on tech-friendly word chars (keeps things like "c++", "node.js", "ci/cd" intact); the
// boundary-punctuation strip afterward keeps a sentence-ending period out of the last word of a
// JD sentence (e.g. "...built with Kubernetes." -> "kubernetes", not "kubernetes.")
function tokenize(loweredText: string): string[] {
  const raw = loweredText.match(/[a-z0-9][a-z0-9+#./-]*/g) || [];
  return raw.map(stripTokenBoundaryPunctuation).filter(Boolean);
}

// a token is "term-like" when the posting capitalizes it as a proper noun, it is tech-shaped,
// or it is on the technical dictionary -- the three ways a word can be a skill rather than prose
function isTermLike(word: string, properNouns: Set<string>): boolean {
  if (properNouns.has(word) || TECH_TERMS.has(word)) return true;
  return /\d/.test(word) || word.slice(1).includes(".") || /[+#]/.test(word);
}

interface CapitalizedToken {
  word: string;
  sentenceInitial: boolean;
  techShaped: boolean;
}

// what a new sentence, bullet or heading looks like from behind. Scraped postings arrive with
// whitespace collapsed, so line breaks are gone -- the bullet glyphs and terminal punctuation
// are the only remaining evidence that a capital letter is positional rather than meaningful.
const SENTENCE_BOUNDARY = /[.!?;:•·▪◦*|)\]\-–—]/;

// every capitalized token, tagged with the two things that decide whether its capital means
// anything: where it sits, and whether it looks like a technology regardless of position
function capitalizedTokens(text: string): CapitalizedToken[] {
  const tokens: CapitalizedToken[] = [];
  const pattern = /[A-Z][A-Za-z0-9+#.]*/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const raw = stripTokenBoundaryPunctuation(match[0]);
    if (!raw) continue;

    let i = match.index - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    const prev = i >= 0 ? text[i] : "";

    tokens.push({
      word: raw.toLowerCase(),
      sentenceInitial: prev === "" || SENTENCE_BOUNDARY.test(prev),
      // a digit (S3), an internal dot (Node.js), a +/# (C++, C#), or an all-caps acronym (REST,
      // SQL) -- shapes ordinary prose does not have, so position stops mattering
      techShaped:
        /\d/.test(raw) ||
        raw.slice(1).includes(".") ||
        /[+#]/.test(raw) ||
        (raw.length >= 2 && raw === raw.toUpperCase()),
    });
  }

  return tokens;
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
  //
  // A capital letter alone is far too weak a signal on its own: every sentence and every bullet
  // opens with one, so "One of our values..." and "Everything we ship..." were being ranked
  // alongside real technologies. A capitalized token only counts when it earns it -- by appearing
  // somewhere that is NOT the start of a sentence or bullet, by being tech-shaped (a digit, an
  // internal dot, +/#, or an all-caps acronym), or by recurring. Kubernetes mentioned once
  // mid-sentence still counts; "Everything" opening three bullets never does.
  for (const { word, sentenceInitial, techShaped } of capitalizedTokens(jobDescription)) {
    if (STOPWORDS.has(word) || word.length < 2) continue;
    if (phraseFragments.has(word)) continue;
    if (sentenceInitial && !techShaped) continue;
    bump(word);
  }

  // words the posting itself treats as proper nouns (capitalized somewhere other than a sentence
  // opening) or that are tech-shaped -- the evidence the frequency rules below test against
  const properNouns = new Set(
    capitalizedTokens(jobDescription)
      .filter((t) => !t.sentenceInitial || t.techShaped)
      .map((t) => t.word)
  );

  // (b) frequent non-stopword unigrams -- require a repeat so generic prose doesn't flood the list
  const rawWords = tokenize(lowered);
  const unigramCounts = new Map<string, number>();
  for (const w of rawWords) {
    if (STOPWORDS.has(w) || w.length < 2 || /^\d+$/.test(w)) continue;
    unigramCounts.set(w, (unigramCounts.get(w) || 0) + 1);
  }
  // frequency alone is not evidence of a keyword -- prose repeats prose. A unigram must also
  // look like a term: capitalized somewhere that isn't a sentence opening (so the posting itself
  // treats it as a proper noun), tech-shaped, or on the small technical dictionary above. This is
  // what stops "often", "folks" and "today" ranking beside "TypeScript".
  for (const [w, c] of unigramCounts) {
    if (c >= 2 && isTermLike(w, properNouns)) bump(w, c);
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
  // a bigram earns its place if either half is a real term ("design system"), never on repetition
  // alone ("interview process")
  for (const [bg, c] of bigramCounts) {
    const [first, second] = bg.split(" ");
    if (c >= 2 && (isTermLike(first, properNouns) || isTermLike(second, properNouns))) bump(bg, c);
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

  // braces are now just grouping, not content -- drop them, but replace with a SPACE rather than
  // deleting outright: adjacent brace groups (e.g. `\href{https://x.com/foo}{\textbf{FooBar}}`,
  // where the URL and the bolded title are two separate {..} groups back to back with nothing
  // between them) would otherwise fuse into one glued token ("x.com/fooFooBar") once the braces
  // vanish, hiding a real project/skill name from the token set entirely. The whitespace-collapse
  // step right below cleans up any doubled-up spaces this introduces.
  text = text.replace(/[{}]/g, " ");

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
  fabricatedAdded: string[];
}

// splits a whitelist phrase into its individual word components on any run of non-alphanumeric
// characters -- deliberately broader than the tech-shaped tokenizers used elsewhere (tokenize/
// tokenizeRaw), since a whitelist entry like "React.js" or "Test-Driven Development (TDD)" must
// also match a bare mention of just "react", "js", or "TDD", not only the exact full phrase
function whitelistComponents(phrase: string): string[] {
  return phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// expands a whitelist of skill phrases into a lookup set containing BOTH each whole phrase
// (lowercased) and every individual word it's made of. Without the component expansion, whitelisting
// a multi-word skill ("Amazon Web Services") still leaves each of its own words ("Amazon", "Web")
// looking unrecognized to any check that compares single tokens/keywords -- an unfixable retry loop
// in the validator, and a false "not on your whitelist" in this report. Exported so validator.ts's
// single-token whitelist check (which has the identical bug) can share one implementation.
export function expandWhitelist(whitelist: string[]): Set<string> {
  const set = new Set<string>();
  for (const entry of whitelist) {
    // normalize the whole-phrase form too (e.g. a stray trailing "." from a copy-pasted whitelist
    // entry), so it stays symmetric with the resume-side token normalization above
    const lower = stripTokenBoundaryPunctuation(entry.toLowerCase().trim());
    if (lower) set.add(lower);
    for (const word of whitelistComponents(entry)) {
      set.add(word);
    }
  }
  return set;
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
  const whitelistLower = expandWhitelist(whitelist);

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
  // a keyword newly matched in the tailored text (wasn't matched in the base) that isn't backed
  // by the whitelist is a fabrication by definition -- this is a whole-text, macro-agnostic
  // backstop on top of the validator's per-macro signals, which can miss e.g. a bare skill name
  // sitting in an unbolded second brace group inside `\item` (Technical Skills), not `\resumeItem`
  const fabricatedAdded = matchedAfter.filter(
    (k) => !matchedBefore.includes(k) && !whitelistLower.has(k)
  );

  return {
    keywords,
    matchedBefore,
    matchedAfter,
    scoreBefore,
    scoreAfter,
    missing,
    missingNotClaimable,
    fabricatedAdded,
  };
}
