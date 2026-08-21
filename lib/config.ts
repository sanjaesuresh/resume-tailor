import fs from "fs";
import path from "path";

// central place for model/path constants so later tasks don't hardcode paths or drift on model choice
export const MODEL = "claude-sonnet-5";
export const MAX_TOKENS = 16000;

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
