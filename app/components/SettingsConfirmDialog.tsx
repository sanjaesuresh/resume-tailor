"use client";

import { useEffect, useId, useRef } from "react";

interface SettingsConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shared confirm dialog for the settings page's two discard-ish confirmations (replacing a saved
 * resume, resetting the prompt over an unsaved edit). A native <dialog> via showModal() gets
 * focus-trapping, Escape-to-close, and focus-return to the triggering button for free -- none of
 * that is hand-rolled here.
 */
export default function SettingsConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: SettingsConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // unique per instance -- both ResumeSection and PromptSection render one of these (mounted,
  // just not open) at the same time, so a hardcoded id would produce a duplicate aria-labelledby
  // target
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        // native Escape-to-close fires "cancel" before the dialog actually closes -- route it
        // through the same handler as the Cancel button so caller state (the `open` prop) stays
        // in sync with reality
        e.preventDefault();
        onCancel();
      }}
    >
      <p id={titleId} className="settings-dialog-title">
        {title}
      </p>
      <p className="settings-dialog-body">{description}</p>
      <div className="na-actions">
        <button type="button" className="na-btn na-btn--primary" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="na-btn na-btn--secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </dialog>
  );
}
