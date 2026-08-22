"use client";

import { useState } from "react";
import SettingsConfirmDialog from "@/app/components/SettingsConfirmDialog";
import { putSettings, useBeforeUnloadWarning, useMountedRef, type Settings } from "@/app/components/settingsHelpers";

interface SettingsPromptSectionProps {
  prompt: string;
  isDefault: boolean;
  onSaved: (settings: Settings) => void;
  onUnauthorized: () => void;
}

/**
 * Tailoring prompt: a large monospace override of the system prompt sent on every run. `prompt`/
 * `isDefault` are always the *effective* values from the server (the override if set, otherwise
 * the built-in default) -- this component never has its own idea of what the default text is.
 */
export default function SettingsPromptSection({
  prompt,
  isDefault,
  onSaved,
  onUnauthorized,
}: SettingsPromptSectionProps) {
  const mounted = useMountedRef();

  // resync-from-prop-via-render pattern (see app/page.tsx's NotesCell): only refires when the
  // prop actually changes underneath this component (a successful save/reset here, or the
  // initial load), never while the user is mid-edit
  const [syncedPrompt, setSyncedPrompt] = useState(prompt);
  const [value, setValue] = useState(prompt);
  if (prompt !== syncedPrompt) {
    setSyncedPrompt(prompt);
    setValue(prompt);
  }

  const [submitting, setSubmitting] = useState<"save" | "reset" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  const dirty = value !== prompt;
  const isEmpty = value.trim().length === 0;

  useBeforeUnloadWarning(dirty);

  function handleChange(text: string) {
    setValue(text);
    setJustSaved(false);
    setSaveError(null);
  }

  async function doSave() {
    setSubmitting("save");
    setSaveError(null);
    const result = await putSettings({ tailorPrompt: value });
    if (!mounted.current) return;
    setSubmitting(null);
    if (!result.ok) {
      if (result.status === 401) return onUnauthorized();
      setSaveError(result.error);
      return;
    }
    onSaved(result.settings);
    setJustSaved(true);
  }

  function handleResetClick() {
    setSaveError(null);
    // discarding an unsaved edit is exactly the silent-data-loss case this page promises to
    // avoid -- confirm first. Nothing to lose if the textarea already matches the saved prompt.
    if (dirty) {
      setConfirmDiscardOpen(true);
    } else {
      doReset();
    }
  }

  async function doReset() {
    setConfirmDiscardOpen(false);
    setSubmitting("reset");
    setSaveError(null);
    // sending the literal value null is what deletes the override server-side, rather than
    // copying the default text in -- see settingsHelpers.ts's SettingsPatch
    const result = await putSettings({ tailorPrompt: null });
    if (!mounted.current) return;
    setSubmitting(null);
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
      <h2 className="rc-heading">Tailoring prompt</h2>
      <p className="na-notice">
        The system prompt sent to the model on every tailoring run. Edit it to change how the
        tool writes — tone, structure, what it prioritizes.
      </p>

      <div className="na-feedback-box">
        <p>
          The no-fabrication checks in the tailoring pipeline run in code, not in this prompt.
          Editing what&apos;s below can change how the model writes — it can&apos;t turn those
          checks off.
        </p>
      </div>

      <p className="na-eyebrow">{isDefault ? "Using the built-in default" : "Custom override"}</p>

      <div className="na-field">
        <label htmlFor="prompt-textarea">Tailoring prompt</label>
        <textarea
          id="prompt-textarea"
          className="na-mono"
          rows={18}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          disabled={submitting !== null}
          aria-invalid={isEmpty ? true : undefined}
          aria-describedby={isEmpty ? "prompt-empty-error" : undefined}
        />
        {isEmpty && (
          <p id="prompt-empty-error" className="na-field-error" role="alert">
            The prompt can&apos;t be empty. Use Reset to default instead.
          </p>
        )}
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
          onClick={doSave}
          disabled={submitting !== null || !dirty || isEmpty}
        >
          {submitting === "save" ? "Saving…" : "Save prompt"}
        </button>
        <button
          type="button"
          className="na-btn na-btn--secondary"
          onClick={handleResetClick}
          disabled={submitting !== null || isDefault}
        >
          {submitting === "reset" ? "Resetting…" : "Reset to default"}
        </button>
        {justSaved && !dirty && (
          <span className="na-notice" role="status">
            Saved.
          </span>
        )}
      </div>

      <SettingsConfirmDialog
        open={confirmDiscardOpen}
        title="Discard your unsaved changes?"
        description="Resetting replaces the prompt below with the built-in default. Your unsaved edits here will be lost."
        confirmLabel="Reset to default"
        onConfirm={doReset}
        onCancel={() => setConfirmDiscardOpen(false)}
      />
    </section>
  );
}
