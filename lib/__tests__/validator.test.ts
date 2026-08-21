import { describe, expect, it } from "vitest";
import {
  checkBulletTooLong,
  checkNonWhitelistedKeyword,
  checkRemovedLines,
  checkUnescapedPercent,
  validateTailored,
} from "../validator";

// base fixture: 2 experience blocks of 3 bullets each, using the REAL template macros
// (\resumeItem, \section) so the default option values are exercised, not just simplified fixtures
const baseTex = String.raw`
\section{Experience}
\resumeSubHeadingListStart
\resumeSubheading
  {Company A}{2020}
  {Engineer}{City}
  \resumeItemListStart
    \resumeItem{Built \textbf{Python} services for internal tooling}
    \resumeItem{Improved reliability by 30\% across the platform}
    \resumeItem{Led a small team of two engineers on a migration project}
  \resumeItemListEnd
\resumeSubheading
  {Company B}{2019}
  {Engineer}{City}
  \resumeItemListStart
    \resumeItem{Designed APIs used by thousands of customers}
    \resumeItem{Wrote documentation for onboarding new engineers}
    \resumeItem{Mentored interns on backend best practices}
  \resumeItemListEnd
\resumeSubHeadingListEnd

\section{Skills}
Python, SQL, Git
`;

describe("checkRemovedLines", () => {
  it("flags a block whose bullet count dropped in the tailored resume", () => {
    const tailoredTex = baseTex.replace(
      "    \\resumeItem{Led a small team of two engineers on a migration project}\n",
      ""
    );

    const violations = checkRemovedLines(baseTex, tailoredTex);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("removed-line");
  });

  it("flags a section that is missing entirely from the tailored resume", () => {
    const tailoredTex = baseTex.replace(/\\section\{Skills\}[\s\S]*$/, "");

    const violations = checkRemovedLines(baseTex, tailoredTex);

    expect(violations.some((v) => v.rule === "removed-line" && /Skills/.test(v.message))).toBe(
      true
    );
  });

  it("does not flag reworded or reordered bullets within the same block", () => {
    const tailoredTex = baseTex
      .replace(
        "Led a small team of two engineers on a migration project",
        "Managed a small group of engineers through a platform migration"
      )
      .replace(
        "Designed APIs used by thousands of customers",
        "Wrote documentation for onboarding new engineers"
      );
    // (swap the text of two bullets in block 2 -- reordering/rewording, not removal)

    const violations = checkRemovedLines(baseTex, tailoredTex);

    expect(violations).toHaveLength(0);
  });

  it("supports a simplified fixture via the bulletMacro option", () => {
    const simpleBase = String.raw`
\section{Experience}
\block{A}
  \item{one}
  \item{two}
\block{B}
  \item{three}
`;
    const simpleTailored = String.raw`
\section{Experience}
\block{A}
  \item{one}
\block{B}
  \item{three}
`;

    const violations = checkRemovedLines(simpleBase, simpleTailored, { bulletMacro: "item" });

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("removed-line");
  });
});

describe("checkBulletTooLong", () => {
  it("flags a bullet whose stripped text exceeds 200 characters, with the offending line", () => {
    const longBullet = "A".repeat(220);
    const tailoredTex = `\\section{Experience}\n\\resumeItem{${longBullet}}\n`;
    const expectedLine = tailoredTex.split("\n").findIndex((l) => l.includes(longBullet)) + 1;

    const violations = checkBulletTooLong(tailoredTex);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("bullet-too-long");
    expect(violations[0].line).toBe(expectedLine);
  });

  it("does not flag a bullet at or under 200 characters", () => {
    const okBullet = "A".repeat(200);
    const tailoredTex = `\\resumeItem{${okBullet}}`;

    const violations = checkBulletTooLong(tailoredTex);

    expect(violations).toHaveLength(0);
  });

  it("flags a bullet at exactly 201 characters (one over the boundary)", () => {
    const boundaryBullet = "A".repeat(201);
    const tailoredTex = `\\resumeItem{${boundaryBullet}}`;

    const violations = checkBulletTooLong(tailoredTex);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("bullet-too-long");
  });

  it("supports a simplified fixture via the bulletMacro option", () => {
    const tailoredTex = `\\item{${"B".repeat(210)}}`;

    const violations = checkBulletTooLong(tailoredTex, { bulletMacro: "item" });

    expect(violations).toHaveLength(1);
  });
});

describe("checkUnescapedPercent", () => {
  it("flags an unescaped percent mid-line", () => {
    const tex = String.raw`\resumeItem{Improved by 30% this quarter}`;

    const violations = checkUnescapedPercent(tex);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("unescaped-percent");
    expect(violations[0].line).toBe(1);
  });

  it("passes when the percent is escaped", () => {
    const tex = String.raw`\resumeItem{Improved by 30\% this quarter}`;

    const violations = checkUnescapedPercent(tex);

    expect(violations).toHaveLength(0);
  });

  it("passes a full-line LaTeX comment (percent at start of line)", () => {
    const tex = "% this whole line is a comment\n\\resumeItem{Improved reliability}";

    const violations = checkUnescapedPercent(tex);

    expect(violations).toHaveLength(0);
  });

  it("passes a comment line indented with leading whitespace", () => {
    const tex = "   % indented comment\n\\resumeItem{Improved reliability}";

    const violations = checkUnescapedPercent(tex);

    expect(violations).toHaveLength(0);
  });
});

describe("checkNonWhitelistedKeyword", () => {
  it("flags a new technology term not on the whitelist", () => {
    const tailoredTex = String.raw`\resumeItem{Deployed infrastructure using \textbf{Terraform} and Python}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, ["python"]);

    expect(violations.some((v) => v.rule === "non-whitelisted-keyword")).toBe(true);
  });

  it("passes once the new term is whitelisted, case-insensitively", () => {
    const tailoredTex = String.raw`\resumeItem{Deployed infrastructure using \textbf{Terraform} and Python}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, ["python", "terraform"]);

    expect(violations).toHaveLength(0);
  });

  it("does not flag ordinary rewording that reuses only base terms", () => {
    const tailoredTex = baseTex.replace(
      "Led a small team of two engineers on a migration project",
      "Managed a small group of engineers through a migration project"
    );

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, []);

    expect(violations).toHaveLength(0);
  });

  it("does not re-flag a technology term already present in the base resume", () => {
    // "Python" already appears in baseTex -- rewording around it should not trigger a violation
    const tailoredTex = baseTex.replace(
      "Built \\textbf{Python} services for internal tooling",
      "Built \\textbf{Python}-based services for internal tooling"
    );

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, []);

    expect(violations).toHaveLength(0);
  });

  // regression test: a fabricated tech term introduced as ordinary prose (no \textbf, no
  // digit/dot/ALL-CAPS shape) must still be caught -- this is the gap signal C closes
  it("flags a new technology term introduced as plain prose, not bolded or shape-matched", () => {
    const tailoredTex = String.raw`\resumeItem{Deployed new services using Kubernetes for orchestration}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, []);

    expect(
      violations.some((v) => v.rule === "non-whitelisted-keyword" && /Kubernetes/.test(v.message))
    ).toBe(true);
  });

  it("passes once that same plain-prose technology term is whitelisted", () => {
    const tailoredTex = String.raw`\resumeItem{Deployed new services using Kubernetes for orchestration}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, ["kubernetes"]);

    expect(violations).toHaveLength(0);
  });

  it("does not flag a sentence-initial capitalized verb that is not whitelisted", () => {
    // "Managed" is the first word of the bullet -- exempt regardless of capitalization
    const tailoredTex = String.raw`\resumeItem{Managed a cross-functional rollout across three regional teams}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, []);

    expect(violations).toHaveLength(0);
  });

  // regression test for the round-2 defect: a blanket "first word of sentence" exemption let a
  // fabricated tech term through simply by opening the bullet -- narrowing the exemption to a
  // closed opener-verb whitelist must catch this
  it("flags a fabricated tech term that opens the bullet (not a recognized opener verb)", () => {
    const tailoredTex = String.raw`\resumeItem{Kubernetes orchestration reduced deploy time by 30\%}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, []);

    expect(
      violations.some((v) => v.rule === "non-whitelisted-keyword" && /Kubernetes/.test(v.message))
    ).toBe(true);
  });

  it("passes once that bullet-opening tech term is whitelisted", () => {
    const tailoredTex = String.raw`\resumeItem{Kubernetes orchestration reduced deploy time by 30\%}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, ["kubernetes"]);

    expect(violations).toHaveLength(0);
  });

  it("flags a fabricated tech term that opens a later sentence in the same bullet", () => {
    const tailoredTex = String.raw`\resumeItem{Led the rollout. Terraform handled provisioning.}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, []);

    expect(
      violations.some((v) => v.rule === "non-whitelisted-keyword" && /Terraform/.test(v.message))
    ).toBe(true);
  });

  it("still exempts recognized opener verbs at the start of a bullet", () => {
    const managed = String.raw`\resumeItem{Managed a cross-functional rollout across three regional teams}`;
    const deployed = String.raw`\resumeItem{Deployed new services across three regional teams}`;
    const built = String.raw`\resumeItem{Built a small internal tool for three regional teams}`;

    expect(checkNonWhitelistedKeyword(baseTex, managed, [])).toHaveLength(0);
    expect(checkNonWhitelistedKeyword(baseTex, deployed, [])).toHaveLength(0);
    expect(checkNonWhitelistedKeyword(baseTex, built, [])).toHaveLength(0);
  });

  it("flags a mid-sentence capitalized common word (accepted false positive)", () => {
    // "Overhaul" is not a technology, but it's capitalized and not sentence-initial -- the
    // design deliberately accepts this false positive because the alternative (missing a real
    // fabricated tech term) is the more expensive failure mode
    const tailoredTex = String.raw`\resumeItem{Led a major Overhaul of the reporting pipeline}`;

    const violations = checkNonWhitelistedKeyword(baseTex, tailoredTex, []);

    expect(
      violations.some((v) => v.rule === "non-whitelisted-keyword" && /Overhaul/.test(v.message))
    ).toBe(true);
  });
});

describe("validateTailored", () => {
  it("returns zero violations for an unmodified copy of the base resume", () => {
    const violations = validateTailored(baseTex, baseTex, []);

    expect(violations).toEqual([]);
  });

  it("aggregates violations from all four rules", () => {
    const longBullet = "C".repeat(220);
    const tailoredTex = baseTex
      // remove a bullet -> removed-line
      .replace(
        "    \\resumeItem{Mentored interns on backend best practices}\n",
        ""
      )
      // unescaped percent -> unescaped-percent
      .replace(
        "Improved reliability by 30\\% across the platform",
        "Improved reliability by 30% across the platform"
      )
      // over-length bullet -> bullet-too-long
      .replace(
        "Designed APIs used by thousands of customers",
        longBullet
      )
      // new non-whitelisted term -> non-whitelisted-keyword (bolded, matching template convention)
      .replace(
        "Wrote documentation for onboarding new engineers",
        "Deployed infrastructure using \\textbf{Terraform}"
      );

    const violations = validateTailored(baseTex, tailoredTex, []);
    const rules = violations.map((v) => v.rule);

    expect(rules).toContain("removed-line");
    expect(rules).toContain("unescaped-percent");
    expect(rules).toContain("bullet-too-long");
    expect(rules).toContain("non-whitelisted-keyword");
  });
});
