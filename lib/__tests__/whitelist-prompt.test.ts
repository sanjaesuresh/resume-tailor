import { describe, expect, it } from "vitest";
import {
  BREADTH_LABELS,
  isWhitelistBreadth,
  renderWhitelistDraft,
  whitelistPrompt,
} from "../prompts/whitelist";
import { parseWhitelist } from "../settings";

describe("isWhitelistBreadth", () => {
  it("accepts only the three defined widths", () => {
    expect([1, 2, 3].every(isWhitelistBreadth)).toBe(true);
  });

  it("rejects anything else, so a malformed request cannot widen the guardrail", () => {
    // the route falls back to the narrowest width on a false here, and that fallback direction
    // is the whole point -- a bad value must never open the guardrail wider than asked
    for (const bad of [0, 4, -1, 2.5, "3", null, undefined, {}, []]) {
      expect(isWhitelistBreadth(bad)).toBe(false);
    }
  });
});

describe("whitelistPrompt", () => {
  it("forbids the narrowest width from inferring anything at all", () => {
    const prompt = whitelistPrompt(1);
    expect(prompt).toMatch(/literally appear/i);
    expect(prompt).toMatch(/empty array/i);
  });

  it("keeps every width away from job titles, employers and industries", () => {
    // the line between "implied by a technology" and "guessed from where they worked" is the one
    // that decides whether a term is defensible in an interview
    for (const breadth of [1, 2, 3] as const) {
      expect(whitelistPrompt(breadth)).toMatch(/job title|employer|industry/i);
    }
  });

  it("tells the widest width to stay conservative rather than maximise coverage", () => {
    expect(whitelistPrompt(3)).toMatch(/conservative/i);
  });

  it("asks for the two groups separately at every width", () => {
    for (const breadth of [1, 2, 3] as const) {
      expect(whitelistPrompt(breadth)).toMatch(/"present"/);
      expect(whitelistPrompt(breadth)).toMatch(/"inferred"/);
    }
  });
});

describe("renderWhitelistDraft", () => {
  it("returns a plain list when nothing was inferred", () => {
    expect(renderWhitelistDraft(["Python", "SQL"], [], 1)).toBe("Python\nSQL");
  });

  it("marks inferred terms with a comment header the user can see", () => {
    const draft = renderWhitelistDraft(["PostgreSQL"], ["SQL"], 2);

    expect(draft).toContain("PostgreSQL");
    expect(draft).toContain("SQL");
    expect(draft).toMatch(/# --- inferred/);
    expect(draft).toMatch(/could not defend/i);
    expect(draft).toContain(BREADTH_LABELS[2]);
  });

  it("keeps every term once the validator's own parser has read it", () => {
    // the marker exists only for the human: parseWhitelist drops "#" lines, so the header cannot
    // leak into the list lib/validator.ts checks against
    const draft = renderWhitelistDraft(["PostgreSQL", "Docker"], ["SQL", "containers"], 3);

    expect(parseWhitelist(draft)).toEqual(["PostgreSQL", "Docker", "SQL", "containers"]);
  });

  it("survives a term that would otherwise look like a comment", () => {
    // "C#" starts with no "#", but a hypothetical "#hashtag" term would be silently dropped by the
    // parser -- worth knowing, and worth pinning that ordinary terms are unaffected
    expect(parseWhitelist(renderWhitelistDraft(["C#", ".NET"], [], 1))).toEqual(["C#", ".NET"]);
  });
});
