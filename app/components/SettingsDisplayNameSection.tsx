"use client";

import { useState } from "react";
import { putSettings, useBeforeUnloadWarning, useMountedRef, type Settings } from "@/app/components/settingsHelpers";

interface SettingsDisplayNameSectionProps {
  name: string | null;
  onSaved: (settings: Settings) => void;
  onUnauthorized: () => void;
}

/** Display name: feeds the download filename a recruiter sees. Smallest of the four sections. */
export default function SettingsDisplayNameSection({
  name,
  onSaved,
  onUnauthorized,
}: SettingsDisplayNameSectionProps) {
  const mounted = useMountedRef();
  const initial = name ?? "";

  // same resync-from-prop pattern as the prompt section (see app/page.tsx's NotesCell)
  const [syncedName, setSyncedName] = useState(initial);
  const [value, setValue] = useState(initial);
  if (initial !== syncedName) {
    setSyncedName(initial);
    setValue(initial);
  }

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = value !== initial;
  useBeforeUnloadWarning(dirty);

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    const result = await putSettings({ displayName: value.trim() });
    if (!mounted.current) return;
    setSaving(false);
    if (!result.ok) {
      if (result.status === 401) return onUnauthorized();
      setSaveError(result.error);
      return;
    }
    onSaved(result.settings);
    setJustSaved(true);
  }

  return (
    <section className="settings-section na-section">
      <h2 className="rc-heading">Name</h2>

      <div className="na-field">
        <label htmlFor="display-name">Name</label>
        <input
          id="display-name"
          type="text"
          autoComplete="name"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setJustSaved(false);
            setSaveError(null);
          }}
          disabled={saving}
          aria-describedby="display-name-hint"
        />
        {/* the hyphen and the id come from downloadFilename, so the example has to match it
            character for character -- an en dash here would show a filename nobody ever gets,
            and the whole point of the example is to stop people typing the filename in */}
        <p id="display-name-hint" className="na-field-hint">
          Just your name — it goes on the file a recruiter downloads. Entering “Jane Doe” gives
          you “Resume - Jane Doe 42.pdf”.
        </p>
      </div>

      {saveError && (
        <p className="na-error" role="alert">
          {saveError}
        </p>
      )}

      <div className="na-actions">
        <button
          type="button"
          className="na-btn na-btn--primary"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save name"}
        </button>
        {justSaved && !dirty && (
          <span className="na-notice" role="status">
            Saved.
          </span>
        )}
      </div>
    </section>
  );
}
