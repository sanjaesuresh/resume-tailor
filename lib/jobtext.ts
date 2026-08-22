// Narrows a job posting to the parts that describe the job: what you'd do and what you need.
// A scraped posting is mostly not that -- benefits, pay bands, EEO statements, "about us", the
// application process -- and feeding all of it to the tailoring call both wastes prompt budget
// and floods ATS keyword extraction with terms like "base pay" that no résumé should chase.
//
// Deliberately separate from scrape.ts: pasted postings need this exactly as much as fetched
// ones, so it belongs where the description is consumed, not where it is fetched.

// Section headings whose content is never about the work. Matched case-sensitively in Title
// Case, which is what distinguishes a heading ("Benefits") from ordinary prose ("benefits from
// a strong test suite") -- scraped text arrives with its whitespace collapsed, so indentation
// and line breaks are gone and casing is the only structural signal left.
const DROP_HEADINGS = [
  "Benefits",
  "Perks",
  "Perks and Benefits",
  "Benefits and Perks",
  "Compensation",
  "Compensation and Benefits",
  "Compensation Range",
  "Base Pay",
  "Base Salary",
  "Pay",
  "Pay Range",
  "Pay Transparency",
  "Salary",
  "Salary Range",
  "Total Rewards",
  "Equity",
  "About Us",
  "About the Company",
  "Our Mission",
  "Our Values",
  "Our Culture",
  "Our Team",
  "Why Join Us",
  "Why Work Here",
  "Equal Employment Opportunity",
  "Equal Opportunity Employer",
  "Equal Opportunity",
  "Diversity and Inclusion",
  "Diversity, Equity and Inclusion",
  "Accommodations",
  "Reasonable Accommodation",
  "How to Apply",
  "Application Process",
  "Interview Process",
  "Hiring Process",
  "Next Steps",
  "Background Check",
  "Privacy Policy",
  "Privacy Notice",
  "E-Verify",
];

// Headings that introduce the job itself. Unknown headings are KEPT (see below) -- this list
// exists so a keep-heading can reopen the text after a dropped section ends. That mattered on a
// real posting whose entire "Technology Stack" paragraph (TypeScript, React, GraphQL, Node.js,
// Postgres, Redis) sat inside its Interview Process section: without the reopen, filtering threw
// away the single most useful paragraph in the ad.
const KEEP_HEADINGS = [
  "Responsibilities",
  "Key Responsibilities",
  "What You'll Do",
  "What You Will Do",
  "What You'll Be Doing",
  "The Role",
  "About the Role",
  "About This Role",
  "Job Description",
  "Role Description",
  "Duties",
  "Day to Day",
  "Impact",
  "Qualifications",
  "Basic Qualifications",
  "Minimum Qualifications",
  "Preferred Qualifications",
  "Requirements",
  "Required Skills",
  "Skills",
  "Nice to Have",
  "Nice to Haves",
  "You Have",
  "You Are",
  "Who You Are",
  "What We're Looking For",
  "What We Are Looking For",
  "Tech Stack",
  "Technology Stack",
  "Our Tech Stack",
  "Technologies",
  "Technical Architecture",
  "Technical Skills",
  "Experience",
];

export type SectionKind = "keep" | "drop";

export interface JobSection {
  heading: string | null; // null for the preamble before any recognized heading
  kind: SectionKind;
  text: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// longest-first so "Compensation and Benefits" wins over "Compensation", and "Base Pay" over "Pay"
const ALL_HEADINGS = [...DROP_HEADINGS, ...KEEP_HEADINGS].sort((a, b) => b.length - a.length);
const DROP_SET = new Set(DROP_HEADINGS);

// case-SENSITIVE on purpose (see DROP_HEADINGS). The trailing lookahead lets a heading be
// followed by a colon, a bullet, or simply the next word, which is what collapsed scrape output
// looks like; the leading boundary keeps "Salary" from matching inside "Salaries".
const HEADING_RE = new RegExp(
  `(?<![A-Za-z])(${ALL_HEADINGS.map(escapeRegExp).join("|")})\\s*:?(?![a-z])`,
  "g"
);

/**
 * Splits a posting into labelled sections. The text before the first recognized heading is the
 * preamble and is always kept -- it holds the job title and usually the company name, which the
 * tailoring call needs to fill in `company` and `role`.
 *
 * An unrecognized heading is kept: dropping text we failed to classify would risk discarding
 * real requirements, while keeping it only risks a little noise.
 */
export function splitSections(jobDescription: string): JobSection[] {
  const matches = [...jobDescription.matchAll(HEADING_RE)];
  if (matches.length === 0) {
    return [{ heading: null, kind: "keep", text: jobDescription.trim() }];
  }

  const sections: JobSection[] = [];

  const preamble = jobDescription.slice(0, matches[0].index).trim();
  if (preamble) sections.push({ heading: null, kind: "keep", text: preamble });

  matches.forEach((match, i) => {
    const heading = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : jobDescription.length;
    sections.push({
      heading,
      kind: DROP_SET.has(heading) ? "drop" : "keep",
      text: jobDescription.slice(start, end).trim(),
    });
  });

  return sections;
}

/**
 * The posting reduced to the job itself. Falls back to the full input whenever filtering would
 * leave too little to work with -- a posting written as one unstructured block must still be
 * tailorable, and an empty description would be far worse than a noisy one.
 */
export function extractRelevantSections(jobDescription: string): string {
  const sections = splitSections(jobDescription);

  const kept = sections
    .filter((s) => s.kind === "keep")
    .map((s) => (s.heading ? `${s.heading}\n${s.text}` : s.text))
    .filter((block) => block.trim().length > 0)
    .join("\n\n")
    .trim();

  // if the classifier ate most of the posting, something went wrong with it, not with the posting
  if (kept.length < jobDescription.length * 0.2) return jobDescription;

  return kept;
}
