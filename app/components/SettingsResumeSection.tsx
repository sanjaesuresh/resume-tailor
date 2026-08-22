"use client";

import { useState } from "react";
import SettingsConfirmDialog from "@/app/components/SettingsConfirmDialog";
import { formatBytes, putSettings, useBeforeUnloadWarning, useMountedRef, type Settings } from "@/app/components/settingsHelpers";

interface SettingsResumeSectionProps {
  resumeTex: string | null;
  onSaved: (settings: Settings) => void;
  onUnauthorized: () => void;
  generatingWhitelist: boolean;
  generateWhitelistError: string | null;
  onGenerateWhitelist: () => void;
}

/**
 * Base resume: a .tex file upload or a paste, whichever the user touched most recently becomes
 * the draft to save. Independent of the other three sections -- a validation error here never
 * discards an in-progress edit in the whitelist or prompt textareas.
 */
export default function SettingsResumeSection({
  resumeTex,
  onSaved,
  onUnauthorized,
  generatingWhitelist,
  generateWhitelistError,
  onGenerateWhitelist,
}: SettingsResumeSectionProps) {
  const mounted = useMountedRef();

  const [fileTex, setFileTex] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [pasteVisible, setPasteVisible] = useState(false);
  // which buffer the Save button should read from -- whichever the user touched most recently,
  // so switching between upload and paste never silently saves the stale one
  const [lastSource, setLastSource] = useState<"file" | "paste" | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const draftTex = lastSource === "file" ? fileTex : lastSource === "paste" ? pasteText : "";
  const draftLabel = lastSource === "file" ? fileName : lastSource === "paste" ? "pasted text" : null;

  // an unsaved draft (a picked file or typed paste that hasn't been saved yet) is exactly the
  // kind of edit this page promises not to lose silently
  useBeforeUnloadWarning(draftTex.trim().length > 0 && !justSaved);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".tex")) {
      setFileError("Choose a .tex file.");
      e.target.value = ""; // clear the pick so re-selecting the same bad file still fires onChange
      return;
    }
    setFileError(null);
    setJustSaved(false);
    setSaveError(null);
    const reader = new FileReader();
    reader.onload = () => {
      setFileTex(typeof reader.result === "string" ? reader.result : "");
      setFileName(file.name);
      setLastSource("file");
    };
    reader.onerror = () => setFileError("Couldn't read that file. Try again or paste the text instead.");
    reader.readAsText(file);
  }

  function handlePasteChange(text: string) {
    setPasteText(text);
    setJustSaved(false);
    setSaveError(null);
    setLastSource(text.trim().length > 0 ? "paste" : lastSource === "paste" ? null : lastSource);
  }

  function handleSaveClick() {
    if (!draftTex.trim()) return;
    setSaveError(null);
    // an existing saved resume is about to be overwritten -- confirm first. A brand-new upload
    // (nothing saved yet) needs no confirmation, there's nothing to lose.
    if (resumeTex) {
      setConfirmOpen(true);
    } else {
      doSave();
    }
  }

  async function doSave() {
    setConfirmOpen(false);
    setSaving(true);
    setSaveError(null);
    const result = await putSettings({ resumeTex: draftTex });
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
      <h2 className="rc-heading">Base resume</h2>
      <p className="na-notice">
        Your base LaTeX resume. Every tailored draft starts from this file, and the skills
        whitelist below is checked against it.
      </p>

      <div className="na-field">
        <span className="na-readonly-label">Currently saved</span>
        <p className="na-readonly-value">
          {resumeTex ? `Resume saved — ${formatBytes(resumeTex)}` : "No resume saved yet."}
        </p>
      </div>

      {resumeTex && (
        <p className="na-field-hint">
          Replacing it only affects future tailoring runs — applications you&apos;ve already
          generated keep their own stored copy and won&apos;t change.
        </p>
      )}

      <div className="na-field">
        <label htmlFor="resume-file">Upload a .tex file</label>
        <input
          id="resume-file"
          type="file"
          accept=".tex,text/x-tex"
          onChange={handleFileChange}
          disabled={saving}
          aria-describedby={fileError ? "resume-file-error" : undefined}
        />
        {fileError && (
          <p id="resume-file-error" className="na-field-error" role="alert">
            {fileError}
          </p>
        )}
      </div>

      {!pasteVisible && (
        <div className="na-actions">
          <button type="button" className="na-link-btn" onClick={() => setPasteVisible(true)}>
            Paste instead
          </button>
        </div>
      )}

      {pasteVisible && (
        <div className="na-field na-paste-box">
          <label htmlFor="resume-paste">Paste your resume&apos;s LaTeX source</label>
          <textarea
            id="resume-paste"
            className="na-mono"
            rows={12}
            value={pasteText}
            onChange={(e) => handlePasteChange(e.target.value)}
            disabled={saving}
          />
        </div>
      )}

      {draftLabel && <p className="na-field-hint">Ready to save: {draftLabel}.</p>}

      {saveError && (
        <p className="na-error" role="alert">
          {saveError}
        </p>
      )}

      <div className="na-actions">
        <button
          type="button"
          className="na-btn na-btn--primary"
          onClick={handleSaveClick}
          disabled={saving || draftTex.trim().length === 0}
        >
          {saving ? "Saving…" : "Save resume"}
        </button>
        {justSaved && (
          <span className="na-notice" role="status">
            Saved.
          </span>
        )}
      </div>

      {justSaved && (
        <div className="na-feedback-box">
          <p>Want a draft skills whitelist based on this resume?</p>
          <div className="na-actions">
            <button
              type="button"
              className="na-btn na-btn--secondary"
              // wrapped, not passed directly: onClick would hand the MouseEvent to the first
              // parameter, which is now the breadth setting
              onClick={() => onGenerateWhitelist()}
              disabled={generatingWhitelist}
              aria-busy={generatingWhitelist || undefined}
            >
              {generatingWhitelist ? "Generating…" : "Generate skills whitelist"}
            </button>
          </div>
          {generatingWhitelist && (
            <div className="na-progress">
              <p className="na-progress-note" role="status">
                Reading your resume and drafting a whitelist — this usually takes 10–30 seconds…
              </p>
              <div className="na-progress-track" aria-hidden="true">
                <div className="na-progress-bar" />
              </div>
            </div>
          )}
          {generateWhitelistError && (
            <p className="na-error" role="alert">
              {generateWhitelistError}
            </p>
          )}
        </div>
      )}

      <SettingsConfirmDialog
        open={confirmOpen}
        title="Replace your saved resume?"
        description="Applications you've already generated keep their own stored copy of your old resume — they won't change. Future tailoring runs will use the new one."
        confirmLabel="Replace resume"
        onConfirm={doSave}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
