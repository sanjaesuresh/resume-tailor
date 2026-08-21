"use client";

import { useId, useState } from "react";

// the only statuses the backend accepts (lib/db.ts VALID_STATUSES) -- kept in sync manually
// since this is a UI-only file and can't import a server module's const array
export type ApplicationStatus = "applied" | "oa" | "interview" | "offer" | "rejected";

const STATUS_OPTIONS: { value: ApplicationStatus; label: string }[] = [
  { value: "applied", label: "Applied" },
  { value: "oa", label: "OA" },
  { value: "interview", label: "Interview" },
  { value: "offer", label: "Offer" },
  { value: "rejected", label: "Rejected" },
];

// visually hides the per-row label from sighted users (the column header already says
// "Status") while keeping it in the accessibility tree so each select has a distinct name
const visuallyHiddenStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

interface StatusSelectProps {
  applicationId: number;
  status: string;
  /** company/role used only to give each select a unique accessible name */
  label: string;
  /** called immediately (optimistic) and again with the previous value if the PATCH fails */
  onStatusChange: (applicationId: number, newStatus: string) => void;
}

export default function StatusSelect({
  applicationId,
  status,
  label,
  onStatusChange,
}: StatusSelectProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rawId = useId();
  // useId() includes colons, which are invalid in a CSS class name
  const selectId = rawId.replace(/:/g, "");
  const errorId = `${selectId}-error`;

  async function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const previous = status;
    const next = event.target.value;
    if (next === previous) return;

    setError(null);
    // reflect the change in the table immediately so the row feels responsive; reverted below
    // if the PATCH turns out to fail
    onStatusChange(applicationId, next);
    setPending(true);

    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to update status (${res.status})`);
      }
    } catch (err) {
      // roll back to the last known-good value and surface the failure inline -- never alert()
      onStatusChange(applicationId, previous);
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <label htmlFor={selectId} style={visuallyHiddenStyle}>
        Status for {label}
      </label>
      <select
        id={selectId}
        className="tr-select"
        value={status}
        onChange={handleChange}
        disabled={pending}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
      >
        {STATUS_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {/* .tr-inline-error is a shared globals.css class (ink & paper --na-danger tokens), not a
          per-instance inline style, so every erroring row/select stays on-palette in both themes */}
      {error && (
        <p id={errorId} role="alert" className="tr-inline-error" style={{ maxWidth: 160 }}>
          {error}
        </p>
      )}
    </div>
  );
}
