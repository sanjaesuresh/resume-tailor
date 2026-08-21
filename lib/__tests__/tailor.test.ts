import fs from "fs";
import { describe, expect, it } from "vitest";
import { tailorResume, type TailoredResume } from "../tailor";
import type { ClaudeProvider, StructuredRequest } from "../provider";
import { WHITELIST_PATH } from "../config";
import { z } from "zod";

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

// builds a fake provider that resolves through a queue of canned responses (one per call) and
// records every request -- lets tests script exact multi-call sequences (retry-then-valid,
// exhausted) without any back end, API or CLI
function fakeProvider(responses: (TailoredResume | null)[]): {
  provider: ClaudeProvider;
  calls: StructuredRequest<z.ZodType>[];
} {
  const calls: StructuredRequest<z.ZodType>[] = [];
  const provider: ClaudeProvider = async <S extends z.ZodType>(req: StructuredRequest<S>) => {
    calls.push(req as unknown as StructuredRequest<z.ZodType>);
    // if called more times than scripted, keep returning the last response (guards against an
    // infinite-seeming loop silently under-asserting call count)
    const index = Math.min(calls.length - 1, responses.length - 1);
    return responses[index] as unknown as z.infer<S> | null;
  };
  return { provider, calls };
}

describe("tailorResume", () => {
  it("happy path: valid tex on the first call, no violations, ATS score does not regress", async () => {
    const validTex = baseTex.replace(
      "Built \\textbf{Python} services for internal tooling",
      "Built \\textbf{Python} and \\textbf{Docker} services for internal tooling"
    );
    const { provider, calls } = fakeProvider([
      { company: "Acme Corp", role: "Backend Engineer", tex: validTex },
    ]);

    const result = await tailorResume(jobDescription, { provider, baseTex, whitelist });

    expect(calls).toHaveLength(1);
    expect(result.violations).toEqual([]);
    expect(result.company).toBe("Acme Corp");
    expect(result.role).toBe("Backend Engineer");
    expect(result.report.scoreAfter).toBeGreaterThanOrEqual(result.report.scoreBefore);

    // the whole request goes through the provider seam: the no-fabrication system prompt, the
    // user message, and the schema that pins company/role/tex -- whichever back end serves it
    expect(calls[0].system).toContain("whitelist");
    expect(calls[0].user).toContain(jobDescription);
    expect(Object.keys(z.toJSONSchema(calls[0].schema).properties ?? {}).sort()).toEqual([
      "company",
      "role",
      "tex",
    ]);
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

    const { provider, calls } = fakeProvider([
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: correctedTex },
    ]);

    const result = await tailorResume(jobDescription, { provider, baseTex, whitelist });

    expect(calls).toHaveLength(2);
    expect(result.violations).toEqual([]);
    expect(result.tex).toBe(correctedTex);
  });

  it("exhausted path: always-violating tex -- exactly 3 calls (initial + 2 retries), violations returned", async () => {
    // always drops the same bullet, no matter how many times Claude is asked to fix it
    const violatingTex = baseTex.replace(
      "    \\resumeItem{Led a small team of two engineers on a migration project}\n",
      ""
    );
    const { provider, calls } = fakeProvider([
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
    ]);

    const result = await tailorResume(jobDescription, { provider, baseTex, whitelist });

    expect(calls).toHaveLength(3);
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

    const { provider, calls } = fakeProvider([
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: correctedTex },
    ]);

    await tailorResume(jobDescription, { provider, baseTex, whitelist });

    const secondCallMessage = calls[1].user;
    expect(secondCallMessage).toContain("removed-line");
    expect(secondCallMessage).toContain(violatingTex);
  });

  it("null response: retries with a distinct parse-failure tag, then surfaces the documented error on exhaustion", async () => {
    // every call comes back null (the provider's "Claude answered but it didn't match the
    // schema" signal), never a tex at all
    const { provider, calls } = fakeProvider([null, null, null]);

    await expect(tailorResume(jobDescription, { provider, baseTex, whitelist })).rejects.toThrow(
      "Claude did not return a parseable resume after all retries"
    );

    expect(calls).toHaveLength(3);

    // the retry message must name the parse failure distinctly from "removed-line" (which means a
    // section/bullet count shrank, not "nothing came back")
    const secondCallMessage = calls[1].user;
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

    const { provider, calls } = fakeProvider([
      { company: "Acme Corp", role: "Backend Engineer", tex: violatingTex },
      { company: "Acme Corp", role: "Backend Engineer", tex: correctedTex },
    ]);

    await tailorResume(jobDescription, { provider, baseTex, whitelist, feedback, previousTex });

    const secondCallMessage = calls[1].user;
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
    const { provider } = fakeProvider([
      { company: "Acme Corp", role: "Backend Engineer", tex },
      { company: "Acme Corp", role: "Backend Engineer", tex },
      { company: "Acme Corp", role: "Backend Engineer", tex },
    ]);

    const result = await tailorResume(jobDescription, { provider, baseTex }); // no whitelist override

    expect(result.violations.some((v) => v.rule === "non-whitelisted-keyword")).toBe(true);
  });
});
