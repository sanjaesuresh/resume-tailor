import fs from "fs";
import { describe, expect, it, vi } from "vitest";
import { tailorResume, type ClaudeClient, type ClaudeParseParams, type TailoredResume } from "../tailor";
import { WHITELIST_PATH } from "../config";

// 2 experience blocks of 3 bullets each, real template macros (\resumeItem, \section) so the
// validator's default bulletMacro is exercised, not just a simplified fixture -- mirrors the
// fixture convention already used in validator.test.ts
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

const whitelist = ["Python", "SQL", "Git", "Docker", "Kubernetes"];

const jobDescription =
  "Looking for a backend engineer with strong Python skills, experience with Docker containers, and Kubernetes orchestration.";

// builds a fake Claude client whose messages.parse resolves through a queue of canned responses
// (one per call) -- lets tests script exact multi-call sequences (retry-then-valid, exhausted)
function fakeClient(responses: (TailoredResume | null)[]): { client: ClaudeClient; parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn<(params: ClaudeParseParams) => Promise<{ parsed_output: TailoredResume | null }>>();
  responses.forEach((r) => parse.mockResolvedValueOnce({ parsed_output: r }));
  // if called more times than scripted, keep returning the last response (guards against an
  // infinite-seeming loop silently under-asserting call count)
  if (responses.length > 0) {
    parse.mockResolvedValue({ parsed_output: responses[responses.length - 1] });
  }
  return { client: { messages: { parse } }, parse };
}

describe("tailorResume", () => {
  it("happy path: valid tex on the first call, no violations, ATS score does not regress", async () => {
    const validTex = baseTex.replace(
      "Built \\textbf{Python} services for internal tooling",
      "Built \\textbf{Python} and \\textbf{Docker} services for internal tooling"
    );
    const { client, parse } = fakeClient([{ company: "Acme Corp", role: "Backend Engineer", tex: validTex }]);

    const result = await tailorResume(jobDescription, { client, baseTex, whitelist });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(result.violations).toEqual([]);
    expect(result.company).toBe("Acme Corp");
    expect(result.role).toBe("Backend Engineer");
    expect(result.report.scoreAfter).toBeGreaterThanOrEqual(result.report.scoreBefore);

    // never pass temperature/top_p/top_k (this model 400s), and never use an assistant-message
    // prefill -- regression guard for the SDK-specifics called out in the brief
    const callArgs = parse.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.temperature).toBeUndefined();
    expect(callArgs.top_p).toBeUndefined();
    expect(callArgs.top_k).toBeUndefined();
    expect((callArgs.messages as { role: string }[]).every((m) => m.role === "user")).toBe(true);
  });

  it("retry path: violating tex on call 1, corrected tex on call 2 -- exactly 2 calls, final violations empty", async () => {
    // call 1: silently drops a whole bullet (removed-line violation)
    const violatingTex = baseTex.replace(
      "    \\resumeItem{Led a small team of two engineers on a migration project}\n",
      ""
    );
    // call 2: same bullet count as base, corrected
    const correctedTex = baseTex.replace(
      "Built \\textbf{Python} services for internal tooling",
      "Built \\textbf{Python} and \\textbf{Docker} services for internal tooling"
    );

    const { client, parse } = fakeClient([
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: correctedTex },
    ]);

    const result = await tailorResume(jobDescription, { client, baseTex, whitelist });

    expect(parse).toHaveBeenCalledTimes(2);
    expect(result.violations).toEqual([]);
    expect(result.tex).toBe(correctedTex);
  });

  it("exhausted path: always-violating tex -- exactly 3 calls (initial + 2 retries), violations returned", async () => {
    // always drops the same bullet, no matter how many times Claude is asked to fix it
    const violatingTex = baseTex.replace(
      "    \\resumeItem{Led a small team of two engineers on a migration project}\n",
      ""
    );
    const { client, parse } = fakeClient([
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
    ]);

    const result = await tailorResume(jobDescription, { client, baseTex, whitelist });

    expect(parse).toHaveBeenCalledTimes(3);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.some((v) => v.rule === "removed-line")).toBe(true);
    // the retry loop still returns the last tex so the UI can show it with warnings, not just an error
    expect(result.tex).toBe(violatingTex);
  });

  it("feeds the enumerated violations from call 1 back into call 2's user message", async () => {
    const violatingTex = baseTex.replace(
      "    \\resumeItem{Led a small team of two engineers on a migration project}\n",
      ""
    );
    const correctedTex = baseTex;

    const { client, parse } = fakeClient([
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: correctedTex },
    ]);

    await tailorResume(jobDescription, { client, baseTex, whitelist });

    const secondCallMessage = (parse.mock.calls[1][0] as ClaudeParseParams).messages[0].content;
    expect(secondCallMessage).toContain("removed-line");
    expect(secondCallMessage).toContain(violatingTex);
  });

  it("null parsed_output: retries with a distinct parse-failure tag, then surfaces the documented error on exhaustion", async () => {
    // every call comes back with parsed_output: null (structured parse failure), never a tex at all
    const { client, parse } = fakeClient([null, null, null]);

    await expect(tailorResume(jobDescription, { client, baseTex, whitelist })).rejects.toThrow(
      "Claude did not return a parseable resume after all retries"
    );

    expect(parse).toHaveBeenCalledTimes(3);

    // the retry message must name the parse failure distinctly from "removed-line" (which means a
    // section/bullet count shrank, not "nothing came back")
    const secondCallMessage = (parse.mock.calls[1][0] as ClaudeParseParams).messages[0].content;
    expect(secondCallMessage).toContain("unparseable-response");
    expect(secondCallMessage).not.toContain("[removed-line]");
    expect(secondCallMessage).toMatch(/could not be parsed/i);
  });

  it("request-changes retry: a validation-triggering violation on call 1 still carries the user's feedback into call 2", async () => {
    const feedback = "Please emphasize my leadership experience more";
    const previousTex = baseTex; // the tex the user is asking to revise

    // call 1 drops a bullet (removed-line violation) despite the feedback path being taken
    const violatingTex = baseTex.replace(
      "    \\resumeItem{Led a small team of two engineers on a migration project}\n",
      ""
    );
    const correctedTex = baseTex;

    const { client, parse } = fakeClient([
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: correctedTex },
    ]);

    await tailorResume(jobDescription, { client, baseTex, whitelist, feedback, previousTex });

    const secondCallMessage = (parse.mock.calls[1][0] as ClaudeParseParams).messages[0].content;
    expect(secondCallMessage).toContain(feedback);
    expect(secondCallMessage).toContain("removed-line");
  });

  it("reads the whitelist from disk (Step 3) when opts.whitelist is not overridden", async () => {
    // exercises the real on-disk parsing path against the actual committed sample asset
    // (WHITELIST_PATH falls back to base-resume.sample's whitelist sibling when no real,
    // gitignored file is present) -- a format change in the sample file would be caught here
    const markdown = fs.readFileSync(WHITELIST_PATH, "utf-8");
    expect(markdown).toContain("Python"); // sanity: fixture assumption below depends on this

    // "Python" is on the disk whitelist and already in baseTex, so bolding it again is not a
    // fabrication; "Terraform" is NOT on the sample whitelist, so introducing it here must be
    // caught as non-whitelisted-keyword
    const tex = baseTex.replace(
      "Built \\textbf{Python} services for internal tooling",
      "Built \\textbf{Python} and \\textbf{Terraform} services for internal tooling"
    );
    const { client } = fakeClient([
      { company: "Acme Corp", role: "Backend Engineer", tex },
      { company: "Acme Corp", role: "Backend Engineer", tex },
      { company: "Acme Corp", role: "Backend Engineer", tex },
    ]);

    const result = await tailorResume(jobDescription, { client, baseTex }); // no whitelist override

    expect(result.violations.some((v) => v.rule === "non-whitelisted-keyword")).toBe(true);
  });
});
