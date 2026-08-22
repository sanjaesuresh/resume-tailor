import { requireUser } from "@/lib/auth";
import { DEFAULT_TAILOR_PROMPT } from "@/lib/prompts/tailor";
import { getUserSettings, saveUserSettings, type UserSettingsPatch } from "@/lib/settings";

// what the settings page reads. tailorPrompt is always the EFFECTIVE prompt so the textarea has
// something to show on a fresh account; isPromptDefault is what tells the UI whether "Reset to
// default" would do anything.
interface SettingsResponse {
  displayName: string | null;
  resumeTex: string | null;
  skillsWhitelist: string | null;
  tailorPrompt: string;
  isPromptDefault: boolean;
}

function toResponse(userId: string): SettingsResponse {
  const settings = getUserSettings(userId);
  return {
    displayName: settings.displayName,
    resumeTex: settings.baseResumeTex,
    skillsWhitelist: settings.skillsWhitelist,
    // resolved at read time rather than copied into the row at signup, so improving the default
    // reaches every user who never customised theirs
    tailorPrompt: settings.tailorPrompt ?? DEFAULT_TAILOR_PROMPT,
    isPromptDefault: settings.tailorPrompt === null,
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  return Response.json({ settings: toResponse(auth.user.id) });
}

/**
 * Applies a partial update. The absent-vs-null distinction is the whole contract here: a field the
 * client did not send is left alone, while an explicit null CLEARS it. That is how the UI's four
 * independent sections each save without stomping the other three, and how "Reset to default"
 * works -- it sends tailorPrompt: null, deleting the override rather than copying the default text
 * into the user's row.
 */
export async function PUT(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid request body" }, { status: 422 });
  }

  const patch: UserSettingsPatch = {};
  // built key-by-key with `in`, never by copying the body: `in` is what preserves "absent means
  // leave it alone", and it also stops an unknown field in the body from reaching the query
  const fields = [
    ["displayName", "displayName"],
    ["resumeTex", "baseResumeTex"],
    ["skillsWhitelist", "skillsWhitelist"],
    ["tailorPrompt", "tailorPrompt"],
  ] as const;

  for (const [wireName, column] of fields) {
    if (!(wireName in body)) continue;
    const value = (body as Record<string, unknown>)[wireName];
    if (value !== null && typeof value !== "string") {
      return Response.json({ error: `${wireName} must be a string or null` }, { status: 422 });
    }
    patch[column] = value;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 422 });
  }

  try {
    saveUserSettings(auth.user.id, patch);
  } catch (err) {
    // saveUserSettings throws with messages written to be read by a user (size caps, "that does
    // not look like LaTeX"), so they pass straight through rather than being flattened to a 500
    const message = err instanceof Error ? err.message : "Could not save settings";
    const tooLarge = /too (long|large)|at most|exceeds/i.test(message);
    return Response.json({ error: message }, { status: tooLarge ? 413 : 422 });
  }

  return Response.json({ settings: toResponse(auth.user.id) });
}
