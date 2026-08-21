import fs from "fs";
import path from "path";

// central place for model/path constants so later tasks don't hardcode paths or drift on model choice
export const MODEL = "claude-sonnet-5";
export const MAX_TOKENS = 16000;

// resolved from process.cwd() (not __dirname) so these work identically from API routes and vitest
export const DATA_DIR = path.join(process.cwd(), "data");
export const ASSETS_DIR = path.join(process.cwd(), "assets");

// real personal files are gitignored (never committed); prefer env override, then the real file on disk, else fall back to the committed sample so the repo still runs after a fresh clone
function resolveAssetPath(envVar: string, realName: string, sampleName: string): string {
  const override = process.env[envVar];
  if (override) return override;
  const realPath = path.join(ASSETS_DIR, realName);
  if (fs.existsSync(realPath)) return realPath;
  return path.join(ASSETS_DIR, sampleName);
}

export const BASE_RESUME_PATH = resolveAssetPath(
  "RESUME_PATH",
  "base-resume.tex",
  "base-resume.sample.tex"
);
export const WHITELIST_PATH = resolveAssetPath(
  "WHITELIST_PATH",
  "skills-whitelist.md",
  "skills-whitelist.sample.md"
);
