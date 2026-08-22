import { describe, expect, it } from "vitest";
import { extractRelevantSections, splitSections } from "../jobtext";
import { extractKeywords } from "../ats";

// scraped postings arrive with their whitespace collapsed, so these fixtures are single-line too --
// that is the shape the section splitter actually has to cope with
const ROLE =
  "Responsibilities Build and operate backend services in TypeScript. Own the ingestion pipeline " +
  "end to end and improve reliability across streaming and batch systems.";
const QUALS =
  "Qualifications Experience with PostgreSQL and Redis. Familiarity with Kubernetes and CI/CD " +
  "pipelines. Strong written communication.";
const MONEY =
  "Benefits Competitive salary and equity. Base Pay Range $150,000 - $200,000. Medical, dental " +
  "and vision insurance. 401k matching and generous paid family leave.";
const LEGAL =
  "Equal Opportunity Employer We consider all qualified applicants regardless of race, colour, " +
  "religion, sex, national origin, disability or veteran status.";

describe("splitSections", () => {
  it("labels money, legal and process sections as droppable and the job itself as keep", () => {
    const sections = splitSections(`${ROLE} ${QUALS} ${MONEY} ${LEGAL}`);
    const byHeading = Object.fromEntries(sections.map((s) => [s.heading, s.kind]));

    expect(byHeading["Responsibilities"]).toBe("keep");
    expect(byHeading["Qualifications"]).toBe("keep");
    expect(byHeading["Benefits"]).toBe("drop");
    expect(byHeading["Equal Opportunity Employer"]).toBe("drop");
  });

  it("keeps the preamble, which carries the job title and company", () => {
    const sections = splitSections(`Design Engineer at Acme. ${ROLE}`);

    expect(sections[0].heading).toBeNull();
    expect(sections[0].kind).toBe("keep");
    expect(sections[0].text).toContain("Design Engineer at Acme");
  });

  it("keeps a heading it does not recognize rather than guessing it is boilerplate", () => {
    const sections = splitSections(`${ROLE} Working Here We ship every day and review each PR.`);
    // "Working Here" is on neither list, so it is never even detected as a heading -- its text
    // stays attached to the section it follows, which is the conservative outcome
    expect(sections.every((s) => s.kind === "keep")).toBe(true);
  });

  it("lets a keep-heading reopen the text inside a dropped section", () => {
    // the real Ashby posting puts its entire tech stack inside the Interview Process section;
    // dropping to the end of that section threw away the most useful paragraph in the ad
    const posting = `${ROLE} Interview Process We do a short intro call and a pairing round. Technology Stack Our stack is TypeScript, React, GraphQL, Node.js, Postgres and Redis. ${MONEY}`;

    const result = extractRelevantSections(posting);

    expect(result).toContain("GraphQL");
    expect(result).toContain("Postgres");
    expect(result).not.toContain("pairing round");
  });
});

describe("extractRelevantSections", () => {
  it("drops compensation and legal boilerplate but keeps the role and qualifications", () => {
    const result = extractRelevantSections(`${ROLE} ${QUALS} ${MONEY} ${LEGAL}`);

    expect(result).toContain("ingestion pipeline");
    expect(result).toContain("PostgreSQL");
    expect(result).not.toContain("401k");
    expect(result).not.toContain("veteran status");
  });

  it("returns the posting untouched when it has no recognizable headings", () => {
    const unstructured =
      "We need someone to build backend services in Python, own deployment, and care about " +
      "latency. You should have shipped production software and be comfortable with SQL.";

    expect(extractRelevantSections(unstructured)).toBe(unstructured);
  });

  it("falls back to the full posting rather than returning almost nothing", () => {
    // a posting that is nearly all boilerplate must still be tailorable
    const mostlyBoilerplate = `Role. ${MONEY} ${LEGAL}`;
    const result = extractRelevantSections(mostlyBoilerplate);

    expect(result).toBe(mostlyBoilerplate);
  });
});

describe("extractKeywords term evidence", () => {
  it("does not treat a sentence-opening capital as a keyword", () => {
    const jd =
      "One of our values is craft. Everything we ship is reviewed. One more thing: we care " +
      "deeply about quality. Everything matters here, and everyone contributes to the outcome.";

    const keywords = extractKeywords(jd);

    expect(keywords).not.toContain("one");
    expect(keywords).not.toContain("everything");
  });

  it("keeps a technology mentioned once mid-sentence", () => {
    const jd = "You will deploy services with Kubernetes and monitor them closely every day.";
    expect(extractKeywords(jd)).toContain("kubernetes");
  });

  it("never ranks compensation boilerplate as a skill", () => {
    const jd =
      "Base Pay Range for this role is competitive. Base pay depends on location. The base pay " +
      "range is reviewed annually, and base pay is only part of total compensation.";

    const keywords = extractKeywords(jd);

    expect(keywords).not.toContain("base pay");
    expect(keywords).not.toContain("base");
    expect(keywords).not.toContain("pay");
  });

  it("drops contraction tails left behind by the tokenizer", () => {
    const jd =
      "We've built a platform we're proud of. You'll own features end to end. We've grown fast " +
      "and you'll ship on day one. We're hiring because we've got more work than people.";

    const keywords = extractKeywords(jd);

    for (const fragment of ["ve", "ll", "re", "don"]) {
      expect(keywords).not.toContain(fragment);
    }
  });
});
