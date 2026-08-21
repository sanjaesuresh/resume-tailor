"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import StatusSelect from "./components/StatusSelect";

// shape of the parsed ats_report JSON column (lib/ats.ts's AtsReport); atsReport on an
// application row is `unknown` server-side, so this is the client's best-effort contract.
// scoreBefore/scoreAfter are marked optional because lib/db.ts's JSON.parse can yield a
// non-null but shapeless `{}` when the stored value is the literal string "{}" -- the type
// system should reflect that these fields aren't guaranteed even when atsReport isn't null
interface AtsReport {
  keywords: string[];
  matchedBefore: string[];
  matchedAfter: string[];
  scoreBefore?: number;
  scoreAfter?: number;
  missing: string[];
  missingNotClaimable: string[];
}

// mirrors lib/db.ts's rowToApplication output (the actual wire shape from
// GET /api/applications), which is camelCase -- not the snake_case db column names.
// notes is nullable because the sqlite column has no NOT NULL constraint
interface Application {
  id: number;
  company: string;
  role: string;
  url: string | null;
  status: string;
  notes: string | null;
  atsReport: AtsReport | null;
  texPath: string | null;
  pdfPath: string | null;
  appliedAt: string | null;
  createdAt: string;
}

// visually hides a label from sighted users while keeping it in the accessibility tree --
// duplicated from StatusSelect.tsx since this task's file boundary forbids a shared module
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

const cellBorderStyle = "1px solid color-mix(in srgb, currentColor 12%, transparent)";

// shared class for every inline row-error (status PATCH failure, notes PATCH failure): a single
// <style> tag defining it is rendered once in Home, instead of each erroring row mounting its
// own near-identical <style> block via a useId()-derived class
const inlineErrorClass = "tracker-inline-error";

// exported as a standalone function so it's a testable seam without a dedicated test file
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Renders the tracker's ATS score cell: the after-score is always the visible headline
    number, and the before→after delta is exposed both via `title` (mouse hover) and via
    visually-hidden text (keyboard/screen-reader users), not hover-only. */
function AtsScoreCell({ atsReport }: { atsReport: AtsReport | null }) {
  // lib/db.ts can yield a non-null but shapeless `{}` for a stored "{}" report, so gate on the
  // actual field's type rather than object truthiness -- otherwise this renders an empty cell
  // with a tooltip that literally reads "undefined → undefined"
  if (typeof atsReport?.scoreAfter !== "number") return <>—</>;

  const hasBefore = typeof atsReport.scoreBefore === "number";
  const title = hasBefore
    ? `${atsReport.scoreBefore} → ${atsReport.scoreAfter}`
    : `${atsReport.scoreAfter}`;

  return (
    <span title={title}>
      {atsReport.scoreAfter}
      <span style={visuallyHiddenStyle}>
        {hasBefore
          ? ` (ATS score improved from ${atsReport.scoreBefore} to ${atsReport.scoreAfter})`
          : ` (ATS score ${atsReport.scoreAfter})`}
      </span>
    </span>
  );
}

/** Inline-editable notes cell: PATCHes on blur, but only if the text actually changed. */
function NotesCell({
  application,
  onSaved,
}: {
  application: Application;
  onSaved: (id: number, notes: string) => void;
}) {
  // a NULL notes column would otherwise make this textarea uncontrolled, so treat
  // null/undefined as "" at every point the value is read
  const notes = application.notes ?? "";
  const [value, setValue] = useState(notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rawId = useId();
  const fieldId = rawId.replace(/:/g, "");
  const errorId = `${fieldId}-error`;

  // if the row's persisted notes change from elsewhere (e.g. a reload), pick that up --
  // adjust state during render (React's documented pattern) instead of an effect, since
  // deriving state from a prop in useEffect is the anti-pattern, not the resync itself:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [syncedNotes, setSyncedNotes] = useState(notes);
  if (notes !== syncedNotes) {
    setSyncedNotes(notes);
    setValue(notes);
  }

  async function handleBlur() {
    if (value === notes) return; // no-op: don't PATCH when nothing changed
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${application.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to save notes (${res.status})`);
      }
      const body = await res.json();
      onSaved(application.id, body.application.notes);
    } catch (err) {
      setValue(notes); // revert the local edit; nothing was persisted
      setError(err instanceof Error ? err.message : "Failed to save notes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <label htmlFor={fieldId} style={visuallyHiddenStyle}>
        Notes for {application.company} — {application.role}
      </label>
      <textarea
        id={fieldId}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        disabled={saving}
        rows={2}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        style={{
          font: "inherit",
          fontSize: 13,
          width: "100%",
          minWidth: 160,
          resize: "vertical",
          padding: "4px 6px",
          borderRadius: 4,
          border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
          background: "var(--background)",
          color: "var(--foreground)",
          opacity: saving ? 0.6 : 1,
        }}
      />
      {error && (
        <p id={errorId} role="alert" className={inlineErrorClass} style={{ fontSize: 12, marginTop: 4 }}>
          {error}
        </p>
      )}
    </div>
  );
}

export default function Home() {
  // null = "not loaded yet" (loading state); [] = "loaded, zero rows" (empty state)
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadApplications = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/applications");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to load applications (${res.status})`);
      }
      const body = await res.json();
      setApplications(body.applications ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load applications");
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount to hydrate this client component from the applications API -- this is
    // synchronizing with an external system (the network), the case react-hooks/set-state-in-effect
    // means to allow ("subscribe... calling setState... when external state changes"); the linter's
    // static analysis just can't see across loadApplications' async/await boundary to confirm that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadApplications();
  }, [loadApplications]);

  // optimistic status update / revert lives here so the table is the single source of truth
  // that both StatusSelect (on change) and NotesCell (on save) write back into
  const handleStatusChange = useCallback((id: number, newStatus: string) => {
    setApplications((prev) =>
      prev ? prev.map((app) => (app.id === id ? { ...app, status: newStatus } : app)) : prev
    );
  }, []);

  const handleNotesSaved = useCallback((id: number, notes: string) => {
    setApplications((prev) =>
      prev ? prev.map((app) => (app.id === id ? { ...app, notes } : app)) : prev
    );
  }, []);

  // defensively sort newest-first client-side too, rather than only trusting the API's
  // ORDER BY -- cheap, and keeps the contract true even if that query ever changes
  const sorted = applications ? [...applications].sort((a, b) => b.id - a.id) : null;

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px", width: "100%" }}>
      {/* single shared definition for every inline row-error (status/notes PATCH failure) --
          rendered once here rather than once per erroring row. Fixed hex red doesn't hold
          4.5:1 contrast against both light and dark --background, and globals.css is off-limits
          to this task, hence a component-scoped style instead of a global stylesheet edit */}
      <style>{`
        .${inlineErrorClass} { color: #b91c1c; }
        @media (prefers-color-scheme: dark) {
          .${inlineErrorClass} { color: #f87171; }
        }
      `}</style>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Applications</h1>
        <Link
          href="/new"
          style={{
            fontSize: 14,
            fontWeight: 500,
            padding: "8px 14px",
            borderRadius: 6,
            border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
          }}
        >
          + New Application
        </Link>
      </div>

      {loadError && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 14px",
            marginBottom: 16,
            borderRadius: 6,
            border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
            background: "color-mix(in srgb, #dc2626 10%, transparent)",
          }}
        >
          <span style={{ fontSize: 14 }}>{loadError}</span>
          <button
            type="button"
            onClick={loadApplications}
            style={{
              font: "inherit",
              fontSize: 13,
              fontWeight: 500,
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      )}

      {sorted === null && !loadError && <p style={{ fontSize: 14 }}>Loading applications…</p>}

      {sorted !== null && sorted.length === 0 && (
        <p style={{ fontSize: 14, color: "var(--foreground)" }}>
          No applications yet.{" "}
          <Link href="/new" style={{ fontWeight: 500, textDecoration: "underline" }}>
            Start a new application
          </Link>{" "}
          to tailor a resume and track it here.
        </p>
      )}

      {sorted !== null && sorted.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
            <thead>
              <tr>
                {["Company", "Role", "Applied", "ATS score", "Status", "Notes", "Links"].map(
                  (heading) => (
                    <th
                      key={heading}
                      scope="col"
                      style={{
                        textAlign: "left",
                        padding: "8px 10px",
                        borderBottom: `2px solid color-mix(in srgb, currentColor 25%, transparent)`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {heading}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((app) => (
                <tr key={app.id}>
                  <td style={{ padding: "10px", borderBottom: cellBorderStyle, fontWeight: 500 }}>
                    {app.company}
                  </td>
                  <td style={{ padding: "10px", borderBottom: cellBorderStyle }}>{app.role}</td>
                  <td style={{ padding: "10px", borderBottom: cellBorderStyle, whiteSpace: "nowrap" }}>
                    {formatDate(app.appliedAt)}
                  </td>
                  <td style={{ padding: "10px", borderBottom: cellBorderStyle, whiteSpace: "nowrap" }}>
                    <AtsScoreCell atsReport={app.atsReport} />
                  </td>
                  <td style={{ padding: "10px", borderBottom: cellBorderStyle }}>
                    <StatusSelect
                      applicationId={app.id}
                      status={app.status}
                      label={`${app.company} — ${app.role}`}
                      onStatusChange={handleStatusChange}
                    />
                  </td>
                  <td style={{ padding: "10px", borderBottom: cellBorderStyle, minWidth: 180 }}>
                    <NotesCell application={app} onSaved={handleNotesSaved} />
                  </td>
                  <td style={{ padding: "10px", borderBottom: cellBorderStyle, whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {app.url ? (
                        <a href={app.url} target="_blank" rel="noopener noreferrer">
                          Posting ↗
                        </a>
                      ) : (
                        <span>—</span>
                      )}
                      {app.pdfPath && <a href={`/api/files/${app.id}/pdf`}>PDF</a>}
                      {app.texPath && <a href={`/api/files/${app.id}/tex`}>TeX</a>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
