import fs from "fs";
import { BASE_RESUME_PATH, WHITELIST_PATH } from "./config";
import { logger } from "./log";
import { DEFAULT_TAILOR_PROMPT } from "./prompts/tailor";
import { getUserSettings, parseWhitelist } from "./settings";
import type { TailorInputs } from "./tailor";

export type ResolveResult =
  | { ok: true; inputs: TailorInputs }
  | { ok: false; error: string };

/**
 * Resolves the three per-person inputs a tailoring run needs from a user's saved settings.
 *
 * This is the single place that answers "whose resume is this", and both /api/tailor and
 * /api/approve go through it -- previously each read the same two fixed files off disk, which is
 * how one person's posting could be tailored against another person's resume.
 *
 * Returns a value rather than throwing for the one failure a user can actually fix themselves
 * (no resume saved yet), so the routes can turn it into a 422 that points at settings.
 */
export function resolveTailorInputs(userId: string): ResolveResult {
  const settings = getUserSettings(userId);

  const baseTex = settings.baseResumeTex ?? developmentFallbackResume();
  if (!baseTex) {
    return {
      ok: false,
      error: "No resume saved yet. Add your LaTeX resume in Settings before tailoring.",
    };
  }

  // an absent whitelist is NOT the same as an empty one, and the difference is worth a word:
  // empty means "introduce nothing new", which is the strict end of the guardrail, not a bypass.
  // A user with a resume but no whitelist still gets a correct, conservative run.
  const whitelistSource = settings.skillsWhitelist ?? developmentFallbackWhitelist() ?? "";

  return {
    ok: true,
    inputs: {
      baseTex,
      whitelist: parseWhitelist(whitelistSource),
      // null means "never customised", so the default is resolved here rather than copied into
      // the user's row at signup -- that way improving the default reaches everyone who kept it
      systemPrompt: settings.tailorPrompt ?? DEFAULT_TAILOR_PROMPT,
    },
  };
}

// Development-only, and deliberately narrow. On a fresh clone the committed sample files let the
// app run end to end without a signup-and-upload dance. In production this must never fire: a
// deployed instance falling back to "whatever resume is on the filesystem" is precisely the
// single-user bug this module exists to remove, so the env check is the whole safety property.
function developmentFallbackResume(): string | null {
  if (process.env.NODE_ENV !== "development") return null;
  return readIfPresent(BASE_RESUME_PATH, "resume");
}

function developmentFallbackWhitelist(): string | null {
  if (process.env.NODE_ENV !== "development") return null;
  return readIfPresent(WHITELIST_PATH, "whitelist");
}

function readIfPresent(filePath: string, label: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  // loud on purpose: silently tailoring against an on-disk file when the user believes their
  // saved settings are in play is the confusing failure worth making obvious in the terminal
  logger("tailor")(`dev fallback · using the on-disk ${label}, not saved settings`);
  return fs.readFileSync(filePath, "utf-8");
}
