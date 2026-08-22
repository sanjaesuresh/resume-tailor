import fs from "fs";
import path from "path";

// central place for model/path constants so later tasks don't hardcode paths or drift on model choice
export const MODEL = "claude-sonnet-5";
export const MAX_TOKENS = 16000;

// Gemini's ids move faster than Anthropic's, so this is env-overridable without a code change.
// Deliberately a *flash* model: on a free-tier key every pro model (gemini-pro-latest,
// gemini-3.1-pro-preview) answers 429 quota-exceeded, and gemini-2.5-pro is 404 "no longer
// available to new users" despite still being listed by models.list. Do not "upgrade" this to a
// pro id without checking the key's quota first -- it will fail on every call, not degrade.
export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3.7-flash";

// deliberately well above MAX_TOKENS: on the 2.5+ models an internal thinking budget is drawn from
// the same output allowance, and a resume that stops mid-document comes back as a schema mismatch
// rather than an obvious truncation. Headroom is far cheaper than diagnosing that twice.
export const GEMINI_MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 32768;

// whose résumé this is -- used for the download filename a recruiter ends up seeing on disk.
// Overridable via .env.local so a fork doesn't ship someone else's name.
export const RESUME_OWNER_NAME = process.env.RESUME_OWNER_NAME?.trim() || "Sanjae Suresh";

// which back end serves the structured model calls. "gemini" uses the Google AI API;
// "cli" spawns the local Claude Code CLI, which bills the Claude Pro subscription; "api" uses
// the Anthropic SDK, which needs pay-as-you-go credits on the API account.
export type ProviderName = "gemini" | "cli" | "api";

const PROVIDER_NAMES: ProviderName[] = ["gemini", "cli", "api"];

/**
 * Picks the back end. An explicit setting always wins; otherwise the presence of a Gemini key is
 * taken as the intent to use it, falling back to the CLI so a machine with no key behaves exactly
 * as it did before Gemini existed.
 *
 * Pure (both inputs passed in) so provider selection is unit-testable without mutating process.env.
 */
export function resolveProviderName(
  raw: string | undefined,
  geminiKeyPresent = false
): ProviderName {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return geminiKeyPresent ? "gemini" : "cli";
  if ((PROVIDER_NAMES as string[]).includes(value)) return value as ProviderName;
  // a typo here would silently route every call to a different billing account, so fail loudly
  // at startup rather than defaulting and surprising the user with a credit-balance 400
  throw new Error(
    `Invalid LLM_PROVIDER "${raw}" -- expected ${PROVIDER_NAMES.map((n) => `"${n}"`).join(", ")}`
  );
}

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || "";

// CLAUDE_PROVIDER is the old name and is still honoured so an existing .env.local keeps working;
// LLM_PROVIDER wins when both are set, since a vendor-neutral name is the one to migrate toward.
// `??` is not enough here: a var present but empty means "not configured" (that is how
// resolveProviderName reads it too), and it must defer to the old name rather than shadow it.
export const PROVIDER = resolveProviderName(
  process.env.LLM_PROVIDER?.trim() || process.env.CLAUDE_PROVIDER,
  GEMINI_API_KEY.length > 0
);

// resolved from process.cwd() (not __dirname) so these work identically from API routes and vitest
export const DATA_DIR = path.join(process.cwd(), "data");
export const ASSETS_DIR = path.join(process.cwd(), "assets");

// real personal files are gitignored (never committed); prefer env override, then the real file on disk, else fall back to the committed sample so the repo still runs after a fresh clone.
// Returns whether the sample was actually used (rather than just the path) so callers can warn --
// silently tailoring the fictional Jane Doe resume/whitelist on a fresh clone or a renamed file is
// the whole bug this return value exists to prevent.
interface ResolvedAsset {
  path: string;
  isSample: boolean;
}

function resolveAssetPath(envVar: string, realName: string, sampleName: string): ResolvedAsset {
  const override = process.env[envVar];
  if (override) return { path: override, isSample: false };
  const realPath = path.join(ASSETS_DIR, realName);
  if (fs.existsSync(realPath)) return { path: realPath, isSample: false };
  return { path: path.join(ASSETS_DIR, sampleName), isSample: true };
}

const resolvedResume = resolveAssetPath("RESUME_PATH", "base-resume.tex", "base-resume.sample.tex");
const resolvedWhitelist = resolveAssetPath(
  "WHITELIST_PATH",
  "skills-whitelist.md",
  "skills-whitelist.sample.md"
);

export const BASE_RESUME_PATH = resolvedResume.path;
export const WHITELIST_PATH = resolvedWhitelist.path;

// API routes call these to decide whether to warn the user their PDF may describe a fictional
// person (sample resume) or that the no-fabrication whitelist was never actually approved by them
// (sample whitelist)
export function usingSampleResume(): boolean {
  return resolvedResume.isSample;
}
export function usingSampleWhitelist(): boolean {
  return resolvedWhitelist.isSample;
}
