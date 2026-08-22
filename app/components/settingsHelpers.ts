// shared plumbing for the four settings sections (app/settings/page.tsx and
// app/components/Settings*.tsx) -- not a component itself, but scoped to the settings page only,
// per this task's file-ownership boundary. Centralizing this here means all four sections handle
// a 401/413/422 response from PUT /api/settings identically instead of drifting section to
// section.

import { useEffect, useRef } from "react";

// the effective settings row returned by both GET and PUT /api/settings -- tailorPrompt is
// always the resolved value (override if set, otherwise the built-in default); isPromptDefault
// is the only way the client can tell which one it's looking at, since a null override and the
// literal default text are indistinguishable once resolved
export interface Settings {
  displayName: string | null;
  resumeTex: string | null;
  skillsWhitelist: string | null;
  tailorPrompt: string;
  isPromptDefault: boolean;
}

// PUT accepts any subset of these; tailorPrompt is the one field where sending the literal value
// `null` is meaningful (it deletes the user's override rather than copying the default text in)
export type SettingsPatch = Partial<{
  displayName: string;
  resumeTex: string;
  skillsWhitelist: string;
  tailorPrompt: string | null;
}>;

export async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  return res.json().catch(() => null);
}

// mirrors app/new/page.tsx's isValidAtsReport: a 200 with an unexpected shape must not crash a
// downstream render (e.g. a section reading .length off a non-string field) -- fail closed into
// the same error path as a network error instead
export function isValidSettings(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    (s.displayName === null || typeof s.displayName === "string") &&
    (s.resumeTex === null || typeof s.resumeTex === "string") &&
    (s.skillsWhitelist === null || typeof s.skillsWhitelist === "string") &&
    typeof s.tailorPrompt === "string" &&
    typeof s.isPromptDefault === "boolean"
  );
}

export type PutSettingsResult =
  | { ok: true; settings: Settings }
  | { ok: false; status: number; error: string };

// every section PUTs only the field(s) it owns, so a validation failure in one section's field
// never discards edits sitting in another -- shared here so all four handle 401 (session
// expired -> caller redirects), 413 (size cap), and 422 (validation) the same way
export async function putSettings(patch: SettingsPatch): Promise<PutSettingsResult> {
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    // 413 has no guaranteed JSON body in the contract (unlike 422's { error }), so this status
    // gets a fixed, generic message rather than trying to parse one out of the response
    if (res.status === 413) {
      return { ok: false, status: 413, error: "That's too large to save. Trim it and try again." };
    }

    const data = await safeJson(res);
    if (res.ok && isValidSettings(data?.settings)) {
      return { ok: true, settings: data.settings };
    }
    const message = typeof data?.error === "string" ? data.error : `Couldn't save (${res.status}).`;
    return { ok: false, status: res.status, error: message };
  } catch {
    return { ok: false, status: 0, error: "Network error while saving." };
  }
}

// resumeTex/skillsWhitelist/tailorPrompt are stored as plain strings, so byte length (not JS
// string .length, which counts UTF-16 code units) is what actually matters against a server-side
// size cap -- shown to the user as a sanity check before they hit that cap, not an exact mirror
// of it
export function formatBytes(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// guards against dispatching a state update after a section unmounts mid-request (e.g. the user
// navigates away while a save is in flight) -- same idiom as app/new/page.tsx's mountedRef,
// shared here since these five files are all under this task's own ownership boundary
export function useMountedRef() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

// warns before an unsaved edit is lost to a tab close/refresh. Doesn't cover in-app Link
// navigation -- the app router has no built-in route-change guard, and adding one is out of
// scope for this task -- so this covers the browser-level case only.
export function useBeforeUnloadWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
