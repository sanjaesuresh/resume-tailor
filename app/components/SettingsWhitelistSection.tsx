"use client";

import { useState } from "react";
import { putSettings, useBeforeUnloadWarning, useMountedRef, type Settings } from "@/app/components/settingsHelpers";
import { BREADTH_LABELS, type WhitelistBreadth } from "@/lib/prompts/whitelist";

// what each width actually costs the user, in their terms rather than the prompt's
const BREADTH_NOTES: Record<WhitelistBreadth, string> = {
  1: "Safest. Nothing you haven't already written down.",
  2: "Adds terms your resume necessarily implies — PostgreSQL means you know SQL.",
  3: "Also adds tools you likely touched but never wrote down. Read every one before saving.",
};

interface SettingsWhitelistSectionProps {
  value: string;
  onChange: (value: string) => void;
  savedValue: string;
  onSaved: (settings: Settings) => void;
  onUnauthorized: () => void;
  generating: boolean;
  generateError: string | null;
  onGenerate: (breadth: WhitelistBreadth) => void;
}

/**
 * Skills whitelist: the one field in the app where the copy has to do real work. This is the
 * only thing that lets the tailoring pipeline add a term beyond what's already in the base
 * resume -- see lib/validator.ts (not owned by this task) for the enforcement side.
 *
 * `value`/`onChange` are lifted to the settings page rather than owned locally, because the base
 * resume section's "generate a draft from this resume" offer writes into this same buffer.
 */
export default function SettingsWhitelistSection({
  value,
  onChange,
  savedValue,
  onSaved,
  onUnauthorized,
  generating,
  generateError,
  onGenerate,
}: SettingsWhitelistSectionProps) {
  const mounted = useMountedRef();
  // starts at the narrowest width every time the page loads. Deliberately not remembered: a
  // widened guardrail should be a choice made now, against the resume in front of you, not one
  // inherited from a session weeks ago.
  const [breadth, setBreadth] = useState<WhitelistBreadth>(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = value !== savedValue;
  const isEmpty = value.trim().length === 0;

  useBeforeUnloadWarning(dirty);

  function handleChange(text: string) {
    onChange(text);
    setJustSaved(false);
    setSaveError(null);
  }

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    const result = await putSettings({ skillsWhitelist: value });
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
      <h2 className="rc-heading">Skills whitelist</h2>

      <p className="na-notice">
        This list is what the tailoring tool is allowed to add to your resume. When it tailors a
        draft, any skill or technology in the result that isn&apos;t already in your base resume
        and isn&apos;t on this list gets rejected. Keep it to things you can genuinely back up in
        an interview — one per line.
      </p>

      <div className="na-feedback-box">
        <p>
          <strong>
            This is the guardrail that stops the tool from inventing experience you don&apos;t
            have.
          </strong>{" "}
          If you leave it empty, you&apos;ve effectively turned that guardrail off — there&apos;s
          nothing here to check new terms against.
        </p>
      </div>

      <div className="na-field">
        <label htmlFor="whitelist-textarea">Skills whitelist</label>
        <textarea
          id="whitelist-textarea"
          className="na-mono"
          rows={10}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving || generating}
          aria-describedby={isEmpty ? "whitelist-empty-hint" : undefined}
        />
        {isEmpty && (
          <p id="whitelist-empty-hint" className="na-field-hint">
            Empty right now — nothing new can be added to a tailored resume until you add skills
            here or generate a draft below.
          </p>
        )}
      </div>

      {/* the slider widens what the generator is allowed to propose, and therefore what the
          tailoring pipeline may later write into a resume. Three labelled stops rather than an
          unlabelled 1-10, because "7" tells you nothing about what you are agreeing to.
          The explainer is static and the note below the track changes with the stop: what the
          control DOES stays put, what this particular setting costs you moves. */}
      <p className="wl-breadth-how">
        Generating replaces the whole list. Wider settings reach further from what your resume
        literally says — and every term here is one the tailor may write into a draft. Terms it
        inferred rather than found are marked; delete any you couldn&apos;t back up in an interview.
      </p>

      <div className="wl-breadth">
        <label htmlFor="whitelist-breadth">How far should it reach?</label>
        <input
          id="whitelist-breadth"
          type="range"
          min={1}
          max={3}
          step={1}
          value={breadth}
          onChange={(e) => setBreadth(Number(e.target.value) as WhitelistBreadth)}
          disabled={generating}
          aria-describedby="whitelist-breadth-note"
        />
        <output htmlFor="whitelist-breadth" className="wl-breadth-label">
          {BREADTH_LABELS[breadth]}
        </output>
        <p id="whitelist-breadth-note" className="na-field-hint">
          {BREADTH_NOTES[breadth]}
        </p>
      </div>

      <div className="na-actions">
        <button
          type="button"
          className="na-btn na-btn--secondary"
          onClick={() => onGenerate(breadth)}
          disabled={generating}
          aria-busy={generating || undefined}
        >
          {generating ? "Generating…" : "Generate from my resume"}
        </button>
      </div>

      {generating && (
        <div className="na-progress">
          <p className="na-progress-note" role="status">
            Reading your resume and drafting a whitelist — this usually takes 10–30 seconds…
          </p>
          <div className="na-progress-track" aria-hidden="true">
            <div className="na-progress-bar" />
          </div>
        </div>
      )}
      {generateError && (
        <p className="na-error" role="alert">
          {generateError}
        </p>
      )}

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
          {saving ? "Saving…" : "Save whitelist"}
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
