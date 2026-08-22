/**
 * Whitelist generation, at three widths.
 *
 * Whatever comes back here becomes a term the tailoring pipeline is PERMITTED to write into a
 * resume -- lib/validator.ts checks new capitalized terms against this list and nothing else. So
 * the width is not a style preference: it is how far the no-fabrication guardrail is opened.
 * Every tier is written to keep each term traceable to something the candidate actually wrote,
 * and the two wider tiers return their additions separately so the user can see what was inferred
 * rather than found.
 */
export type WhitelistBreadth = 1 | 2 | 3;

export const WHITELIST_BREADTHS: WhitelistBreadth[] = [1, 2, 3];

export function isWhitelistBreadth(value: unknown): value is WhitelistBreadth {
  return value === 1 || value === 2 || value === 3;
}

/** Shown next to the slider, and reused as the comment header in the generated draft. */
export const BREADTH_LABELS: Record<WhitelistBreadth, string> = {
  1: "Only what's written in my resume",
  2: "Also directly implied terms",
  3: "Also adjacent tools I likely touched",
};

const SHARED_RULES = `
Rules that apply at every width:
- Copy terms as they are written in the document. Do not translate, expand, or restyle them.
- Do not infer a skill from a job title, an employer, an industry, or a degree.
- Exclude company names, school names, person names, city names, and section headings.
- Exclude generic prose such as "collaboration", "communication", "teamwork", "leadership".
- Strip LaTeX markup from every term you return.
- No duplicates, and never repeat a "present" term inside "inferred".`;

const TIER_RULES: Record<WhitelistBreadth, string> = {
  1: `Return ONLY technologies that literally appear in the document.

"inferred" must be an empty array. Add nothing, however obviously related: if the resume says
"PostgreSQL", do not also return "SQL", "databases", or "MySQL".`,

  2: `In "present", return every technology that literally appears in the document.

In "inferred", additionally return terms DIRECTLY IMPLIED by one of those, where the implication
is a fact about the technology rather than a guess about the person. Each one must be something
the candidate could not plausibly deny knowing given what they wrote.

Good: PostgreSQL implies SQL. Node.js implies JavaScript. React implies JSX. Django implies
Python. Kubernetes implies containers.
Not allowed: a language they never wrote, a competing product, a tool that merely often appears
alongside theirs, or anything derived from where they worked.`,

  3: `In "present", return every technology that literally appears in the document.

In "inferred", additionally return directly implied terms AND adjacent tooling from the same
ecosystem that this candidate very likely touched to do the work described.

Good: Docker implies containers and suggests Docker Compose. React suggests npm and a bundler.
PostgreSQL suggests database migrations and connection pooling. A CI pipeline suggests YAML.
Still not allowed: a different language or framework they never mention, a competing product
they may never have used, anything inferred from an employer or an industry, and anything you
would only guess at from the job title.

Be conservative inside this width. The candidate has to defend every one of these in an
interview, and a term they cannot defend is worse for them than a term they never claimed.`,
};

export function whitelistPrompt(breadth: WhitelistBreadth): string {
  return `You extract technology names from a LaTeX resume.

${TIER_RULES[breadth]}
${SHARED_RULES}

Return a JSON object with two fields: "present" and "inferred", each an array of strings.`;
}

/**
 * Renders the draft the user edits. The two groups are split by a "#" comment header, which
 * parseWhitelist drops -- so the marker survives in the saved text and stays visible, while the
 * validator sees a flat list. That is the cheapest way to keep "this one was inferred, check it"
 * attached to a term without inventing a second storage format for the whitelist.
 */
export function renderWhitelistDraft(
  present: string[],
  inferred: string[],
  breadth: WhitelistBreadth
): string {
  const lines = [...present];
  if (inferred.length > 0) {
    lines.push("");
    lines.push(`# --- inferred, not written in your resume (${BREADTH_LABELS[breadth]}) ---`);
    lines.push("# delete anything here you could not defend in an interview");
    lines.push(...inferred);
  }
  return lines.join("\n");
}
