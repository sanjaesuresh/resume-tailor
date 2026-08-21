import { describe, expect, it } from "vitest";
import { buildReport, extractKeywords, stripLatex } from "../ats";

describe("extractKeywords", () => {
  it("finds tech keywords and known multi-word phrases while dropping stopwords", () => {
    const jd = `We are looking for a Software Engineer with experience in Python and Kubernetes.
The ideal candidate has strong unit testing skills and works well in a team environment.`;

    const keywords = extractKeywords(jd);

    expect(keywords).toContain("python");
    expect(keywords).toContain("kubernetes");
    expect(keywords).toContain("unit testing");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("team");
  });

  it("dedupes case-insensitively and lowercases output", () => {
    const jd = "Python PYTHON python Kubernetes kubernetes";

    const keywords = extractKeywords(jd);
    const pythonHits = keywords.filter((k) => k === "python");

    expect(pythonHits).toHaveLength(1);
    expect(keywords).toContain("kubernetes");
  });

  it("caps the result around 60 keywords", () => {
    // repeat lots of distinct capitalized "words" so raw candidates comfortably exceed the cap
    const jd = Array.from({ length: 100 }, (_, i) => `Technology${i}`).join(" ") + " uses Python.";

    const keywords = extractKeywords(jd);

    expect(keywords.length).toBeLessThanOrEqual(60);
  });

  it("does not extract slash-separated fragments when phrase is matched (CI/CD)", () => {
    const keywords = extractKeywords("Experience with CI/CD pipelines and CI/CD best practices");

    expect(keywords).toContain("ci/cd");
    expect(keywords).not.toContain("ci");
    expect(keywords).not.toContain("cd");
  });

  it("extracts multi-word tech phrases like 'machine learning' with correct counting", () => {
    const keywords = extractKeywords(
      "Machine learning is important. We use machine learning and deep learning daily."
    );

    expect(keywords).toContain("machine learning");
    expect(keywords).toContain("deep learning");
  });
});

describe("stripLatex", () => {
  it("unwraps bold-command macros and leaves no backslashes", () => {
    const tex = String.raw`\textbf{Python developer}`;

    const text = stripLatex(tex);

    expect(text).toContain("Python developer");
    expect(text).not.toContain("\\");
  });

  it("strips comments and resumeItem-style macros while keeping the argument text", () => {
    const tex = String.raw`% this is a comment, not content
\resumeItem{Built systems using \textbf{Python} and \textbf{Kubernetes}}`;

    const text = stripLatex(tex);

    expect(text).not.toContain("comment");
    expect(text).toContain("Built systems using Python and Kubernetes");
    expect(text).not.toContain("\\");
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
  });
});

describe("buildReport", () => {
  it("scores higher after tailoring and flags un-claimable missing keywords", () => {
    const jd =
      "This DevOps role requires strong Python and Kubernetes skills, familiarity with Docker, and solid unit testing practices.";

    const baseTex = String.raw`\resumeItem{Built backend services using \textbf{Python}}`;
    const tailoredTex = String.raw`\resumeItem{Built backend services using \textbf{Python} and \textbf{Kubernetes}, containerized with strong testing practices}`;

    // docker and unit testing are deliberately left off the whitelist: they must not be claimable
    const whitelist = ["python", "kubernetes", "devops"];

    const report = buildReport(jd, baseTex, tailoredTex, whitelist);

    expect(report.keywords.length).toBeGreaterThan(0);
    expect(report.matchedBefore).toContain("python");
    expect(report.matchedBefore).not.toContain("kubernetes");
    expect(report.matchedAfter).toContain("kubernetes");
    expect(report.scoreAfter).toBeGreaterThan(report.scoreBefore);
    expect(report.missing).toContain("docker");
    expect(report.missingNotClaimable).toContain("docker");
    expect(report.missingNotClaimable).not.toContain("kubernetes");
  });
});
