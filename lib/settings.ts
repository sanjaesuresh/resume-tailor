import { getDb } from "./db";

// mirrors UserSettingsPatch: every field the UI can save independently. updatedAt is
// server-stamped, not caller-set -- it is part of the read shape but never written from a patch.
export interface UserSettings {
  displayName: string | null;
  baseResumeTex: string | null;
  skillsWhitelist: string | null;
  tailorPrompt: string | null; // null means "use the built-in default"
  updatedAt: string | null;
}

export type UserSettingsPatch = Partial<UserSettings>;

// raw row shape as stored in sqlite (snake_case columns from migration version 2 in lib/migrate.ts)
interface UserSettingsRow {
  user_id: string;
  display_name: string | null;
  base_resume_tex: string | null;
  skills_whitelist: string | null;
  tailor_prompt: string | null;
  updated_at: string | null;
}

// a fresh account has no user_settings row at all -- the common case, not an error -- so every
// field reads as null rather than making every caller special-case "row missing" vs "row present
// with nulls"
const EMPTY_SETTINGS: UserSettings = {
  displayName: null,
  baseResumeTex: null,
  skillsWhitelist: null,
  tailorPrompt: null,
  updatedAt: null,
};

function rowToSettings(row: UserSettingsRow): UserSettings {
  return {
    displayName: row.display_name,
    baseResumeTex: row.base_resume_tex,
    skillsWhitelist: row.skills_whitelist,
    tailorPrompt: row.tailor_prompt,
    updatedAt: row.updated_at,
  };
}

export function getUserSettings(userId: string): UserSettings {
  const conn = getDb();
  const row = conn
    .prepare("SELECT * FROM user_settings WHERE user_id = ?")
    .get(userId) as UserSettingsRow | undefined;
  return row ? rowToSettings(row) : { ...EMPTY_SETTINGS };
}

// size caps, enforced before anything reaches sqlite or (later) a model call. Values chosen to
// match the plan: a full resume/prompt/whitelist is a few kilobytes, these are generous headroom
// against a pasted-in disk-filler, not a tight fit.
const MAX_BASE_RESUME_TEX_CHARS = 500_000;
const MAX_SKILLS_WHITELIST_CHARS = 32_000;
const MAX_TAILOR_PROMPT_CHARS = 32_000;
const MAX_DISPLAY_NAME_CHARS = 100;

// the display name reaches a Content-Disposition header verbatim (app/api/files/[id]/[kind]/route.ts's
// downloadFilename) -- these characters could break out of the quoted filename value or inject a
// header-terminating newline, so they're stripped the same way that route already strips
// RESUME_OWNER_NAME, rather than duplicating a second, differently-behaved sanitizer
function sanitizeDisplayName(name: string): string {
  return name.replace(/["\\\r\n]/g, "").trim();
}

// a user who pastes a plain-text resume would otherwise only discover the mistake at compile
// time, several steps later -- this catches it at save time while it's still one field to fix
function looksLikeLatex(tex: string): boolean {
  return tex.includes("\\documentclass") || tex.includes("\\begin{document}");
}

// the whitelist file is markdown: a "# ..." header, a short prose blurb explaining the rules,
// blank lines, then one skill per line. Skills are short noun phrases (rarely more than a
// handful of words); the intro prose reads as full sentences, so a word-count cutoff separates
// "commentary to skip" from "skill to keep" without needing the prose to follow any stricter
// format. Kept byte-for-byte identical to the copies this replaces in lib/tailor.ts and
// app/api/approve/route.ts -- changing this silently changes what the no-fabrication validator
// accepts.
const WHITELIST_COMMENT_MAX_WORDS = 6;

export function parseWhitelist(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0) // blank lines
    .filter((line) => !line.startsWith("#")) // markdown header
    .filter((line) => line.split(/\s+/).length <= WHITELIST_COMMENT_MAX_WORDS); // intro prose
}

// column values to bind into the upsert below. A key is present in this object only when the
// caller's patch had that key (via hasOwnProperty, not truthiness) -- that presence, not the
// value, is what the SET clause in saveUserSettings reads to decide "write this" vs "leave it".
interface PatchedColumns {
  display_name?: string | null;
  base_resume_tex?: string | null;
  skills_whitelist?: string | null;
  tailor_prompt?: string | null;
}

export function saveUserSettings(userId: string, patch: UserSettingsPatch): UserSettings {
  const values: PatchedColumns = {};

  // hasOwnProperty (not `patch.displayName !== undefined`) is what makes an explicit
  // `{ tailorPrompt: null }` distinguishable from an omitted key -- the reset-to-default button
  // depends on this: it must clear the override, not be silently ignored as "no change". The
  // `=== undefined` arm only matters for a caller who bypasses the UserSettingsPatch type and
  // writes `{ displayName: undefined }` explicitly -- Partial<T> types that as legal, so it's
  // handled the same as null (clear) rather than left to fall through as a stored `undefined`.
  if (Object.prototype.hasOwnProperty.call(patch, "displayName")) {
    const value = patch.displayName;
    if (value === null || value === undefined) {
      values.display_name = null;
    } else {
      const sanitized = sanitizeDisplayName(value);
      if (sanitized.length > MAX_DISPLAY_NAME_CHARS) {
        throw new Error(`Display name must be at most ${MAX_DISPLAY_NAME_CHARS} characters.`);
      }
      values.display_name = sanitized;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "baseResumeTex")) {
    const value = patch.baseResumeTex;
    if (value === null || value === undefined) {
      values.base_resume_tex = null;
    } else {
      if (value.length > MAX_BASE_RESUME_TEX_CHARS) {
        throw new Error(`Resume is too large (max ${MAX_BASE_RESUME_TEX_CHARS} characters).`);
      }
      // empty string is allowed through (nothing uploaded yet); only a non-empty, non-LaTeX
      // paste is rejected
      if (value.trim().length > 0 && !looksLikeLatex(value)) {
        throw new Error(
          "That doesn't look like a LaTeX resume. It must contain \\documentclass or \\begin{document}."
        );
      }
      values.base_resume_tex = value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "skillsWhitelist")) {
    const value = patch.skillsWhitelist;
    if (value === null || value === undefined) {
      values.skills_whitelist = null;
    } else {
      if (value.length > MAX_SKILLS_WHITELIST_CHARS) {
        throw new Error(`Skills whitelist is too large (max ${MAX_SKILLS_WHITELIST_CHARS} characters).`);
      }
      values.skills_whitelist = value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "tailorPrompt")) {
    const value = patch.tailorPrompt;
    if (value === null || value === undefined) {
      values.tailor_prompt = null;
    } else {
      if (value.length > MAX_TAILOR_PROMPT_CHARS) {
        throw new Error(`Tailoring prompt is too large (max ${MAX_TAILOR_PROMPT_CHARS} characters).`);
      }
      values.tailor_prompt = value;
    }
  }

  const conn = getDb();
  const now = new Date().toISOString();

  // one upsert, not a read-modify-write, so two concurrent saves touching different fields can't
  // clobber each other. A column present in `values` (bound key check below, not the bound
  // value -- an explicit null is still "present") takes the newly-bound value on conflict; a
  // column absent from the patch keeps whatever is already stored via `user_settings.<col>`. On
  // a fresh INSERT there is no existing row to preserve, so binding null for an absent column is
  // already the correct default.
  const columns: (keyof PatchedColumns)[] = [
    "display_name",
    "base_resume_tex",
    "skills_whitelist",
    "tailor_prompt",
  ];
  const setClause = columns
    .map((col) =>
      Object.prototype.hasOwnProperty.call(values, col)
        ? `${col} = excluded.${col}`
        : `${col} = user_settings.${col}`
    )
    .concat("updated_at = excluded.updated_at")
    .join(", ");

  conn
    .prepare(
      `
    INSERT INTO user_settings (user_id, display_name, base_resume_tex, skills_whitelist, tailor_prompt, updated_at)
    VALUES (@user_id, @display_name, @base_resume_tex, @skills_whitelist, @tailor_prompt, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET ${setClause}
  `
    )
    .run({
      user_id: userId,
      display_name: values.display_name ?? null,
      base_resume_tex: values.base_resume_tex ?? null,
      skills_whitelist: values.skills_whitelist ?? null,
      tailor_prompt: values.tailor_prompt ?? null,
      updated_at: now,
    });

  return getUserSettings(userId);
}
