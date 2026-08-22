"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import StatusSelect from "../components/StatusSelect";

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
  // the API deliberately no longer sends the stored filesystem paths -- they disclosed the
  // server's directory layout and, now that artifacts are namespaced, the owner's user id.
  // These flags carry the only thing this table ever used them for.
  hasTex: boolean;
  hasPdf: boolean;
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
    <span title={title} className="na-num">
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
        className="tr-notes-field"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        disabled={saving}
        rows={2}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
      />
      {error && (
        <p id={errorId} role="alert" className="tr-inline-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Two-step delete: the first click arms it, the second confirms. Deliberately not a modal --
    the row itself is the context, and a dialog that says "are you sure?" away from the row it
    refers to is easier to confirm on the wrong one. Deleting removes the stored tex and pdf too,
    so the armed state says so rather than just asking twice. */
function DeleteCell({
  application,
  onDeleted,
  onUnauthorized,
}: {
  application: Application;
  onDeleted: (id: number) => void;
  onUnauthorized: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${application.id}`, { method: "DELETE" });
      if (res.status === 401) return onUnauthorized();
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not delete (${res.status})`);
      }
      onDeleted(application.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
      setDeleting(false);
      setArmed(false);
    }
  }

  if (!armed) {
    return (
      <div className="tr-delete">
        <button type="button" className="tr-delete-btn" onClick={() => setArmed(true)}>
          Delete
          <span className="visually-hidden">
            {` ${application.company} — ${application.role}`}
          </span>
        </button>
        {error && (
          <p className="tr-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="tr-delete" role="group" aria-label={`Confirm deleting ${application.company}`}>
      <p className="tr-delete-warning">Delete this and its files?</p>
      <button
        type="button"
        className="tr-delete-btn tr-delete-btn--confirm"
        onClick={handleDelete}
        disabled={deleting}
      >
        {deleting ? "Deleting…" : "Yes, delete"}
      </button>
      <button
        type="button"
        className="tr-delete-btn"
        onClick={() => setArmed(false)}
        disabled={deleting}
      >
        Cancel
      </button>
    </div>
  );
}

export default function Home() {
  // null = "not loaded yet" (loading state); [] = "loaded, zero rows" (empty state)
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const router = useRouter();

  const loadApplications = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/applications");
      // an expired or missing session is not an error worth rendering -- without this it shows as
      // "Failed to load applications (401)", which reads as a broken app rather than "sign in"
      if (res.status === 401) {
        router.push("/signin");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to load applications (${res.status})`);
      }
      const body = await res.json();
      setApplications(body.applications ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load applications");
    }
  }, [router]);

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

  // dropped from local state only after the server confirms -- an optimistic removal here would
  // make a failed delete look like it worked until the next reload, which is the worst outcome
  // for an irreversible action
  const handleDeleted = useCallback((id: number) => {
    setApplications((prev) => (prev ? prev.filter((app) => app.id !== id) : prev));
  }, []);

  // defensively sort newest-first client-side too, rather than only trusting the API's
  // ORDER BY -- cheap, and keeps the contract true even if that query ever changes
  const sorted = applications ? [...applications].sort((a, b) => b.id - a.id) : null;

  return (
    <main className="tr-root">
      <div className="tr-header">
        <h1 className="tr-title">Applications</h1>
        <Link href="/new" className="na-btn na-btn--secondary">
          + New Application
        </Link>
      </div>

      {loadError && (
        <div role="alert" className="tr-error">
          <span>{loadError}</span>
          <button type="button" onClick={loadApplications} className="tr-retry-btn">
            Retry
          </button>
        </div>
      )}

      {sorted === null && !loadError && (
        // skeleton rows (shape-matched to the table below) rather than a bare "Loading…" string,
        // so the page doesn't jump when the real rows arrive
        <div className="tr-skeleton" role="status" aria-label="Loading applications">
          <div className="tr-skeleton-row" aria-hidden="true" />
          <div className="tr-skeleton-row" aria-hidden="true" />
          <div className="tr-skeleton-row" aria-hidden="true" />
        </div>
      )}

      {sorted !== null && sorted.length === 0 && (
        <p className="tr-empty">
          No applications yet.{" "}
          <Link href="/new">Start a new application</Link> to tailor a resume and track it here.
        </p>
      )}

      {sorted !== null && sorted.length > 0 && (
        <div className="tr-table-wrap">
          <table className="tr-table">
            <thead>
              <tr>
                {["Company", "Role", "Applied", "ATS score", "Status", "Notes", "Links"].map(
                  (heading) => (
                    <th key={heading} scope="col">
                      {heading}
                    </th>
                  )
                )}
                {/* the delete column carries no visible heading -- the buttons name themselves --
                    but a column with no header at all leaves screen-reader users without one */}
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((app) => (
                <tr key={app.id}>
                  <td>{app.company}</td>
                  <td>
                    {/* the role IS the posting -- linking it here retires the separate "Posting"
                        link, leaving the Links column to the two files this app produced */}
                    {app.url ? (
                      <a
                        className="tr-role-link"
                        href={app.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {app.role}
                        <span className="tr-ext" aria-hidden="true">
                          ↗
                        </span>
                        <span className="visually-hidden"> (opens the job posting in a new tab)</span>
                      </a>
                    ) : (
                      app.role
                    )}
                  </td>
                  <td className="tr-num" style={{ whiteSpace: "nowrap" }}>{formatDate(app.appliedAt)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <AtsScoreCell atsReport={app.atsReport} />
                  </td>
                  <td>
                    <StatusSelect
                      applicationId={app.id}
                      status={app.status}
                      label={`${app.company} — ${app.role}`}
                      onStatusChange={handleStatusChange}
                    />
                  </td>
                  <td style={{ minWidth: 180 }}>
                    <NotesCell application={app} onSaved={handleNotesSaved} />
                  </td>
                  <td>
                    <div className="tr-links">
                      {app.hasPdf && <a href={`/api/files/${app.id}/pdf`}>PDF</a>}
                      {app.hasTex && <a href={`/api/files/${app.id}/tex`}>TeX</a>}
                      {!app.hasPdf && !app.hasTex && <span>—</span>}
                    </div>
                  </td>
                  <td>
                    <DeleteCell
                      application={app}
                      onDeleted={handleDeleted}
                      onUnauthorized={() => router.push("/signin")}
                    />
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
