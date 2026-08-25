"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AtsReport } from "@/lib/ats";
import type { TailorViolation } from "@/lib/tailor";
import ReportCard from "@/app/components/ReportCard";
import DiffView from "@/app/components/DiffView";
import PdfPreview from "@/app/components/PdfPreview";
import { AuthGateLoading, useRequireSession } from "@/app/components/useRequireSession";

// ---- explicit state machine -------------------------------------------------
// Each stage is its own object shape (a discriminated union keyed on `stage`) rather than one big
// object with optional fields, so e.g. "approveError" can't exist while stage is "url" -- the
// reducer can only ever construct a state the current stage actually supports.

type Stage = "url" | "confirm" | "review" | "done";

interface UrlStage {
  stage: "url";
  url: string;
  pasteVisible: boolean;
  pasteReason: "manual" | "failed" | null;
  pasteText: string;
  scrapeLoading: boolean;
  scrapeError: string | null;
}

interface ConfirmStage {
  stage: "confirm";
  url: string;
  jobDescription: string;
  tailorLoading: boolean;
  tailorError: string | null;
}

interface ReviewStage {
  stage: "review";
  url: string;
  jobDescription: string;
  baseTex: string;
  tex: string;
  company: string;
  role: string;
  violations: TailorViolation[];
  report: AtsReport;
  tailorLoading: boolean;
  tailorError: string | null;
  feedbackText: string;
  approveLoading: boolean;
  approveError: string | null;
  compileLog: string | null;
}

interface DoneStage {
  stage: "done";
  url: string;
  company: string;
  role: string;
  pdfUrl: string;
  texUrl: string;
  applicationId: number;
}

type State = UrlStage | ConfirmStage | ReviewStage | DoneStage;

type Action =
  | { type: "SET_URL"; url: string }
  | { type: "TOGGLE_PASTE" }
  | { type: "SET_PASTE_TEXT"; text: string }
  | { type: "SCRAPE_START" }
  | { type: "SCRAPE_SUCCESS"; description: string }
  | { type: "SCRAPE_FAILED"; message: string }
  | { type: "CONTINUE_WITH_PASTE" }
  | { type: "SET_JOB_DESCRIPTION"; text: string }
  | { type: "BACK_TO_URL" }
  | { type: "TAILOR_START" }
  | {
      type: "TAILOR_SUCCESS";
      data: {
        tex: string;
        baseTex: string;
        company: string;
        role: string;
        violations: TailorViolation[];
        report: AtsReport;
      };
    }
  | { type: "TAILOR_FAILED"; message: string }
  | { type: "SET_COMPANY"; value: string }
  | { type: "SET_ROLE"; value: string }
  | { type: "SET_FEEDBACK_TEXT"; value: string }
  | { type: "APPROVE_START" }
  | { type: "APPROVE_SUCCESS"; pdfUrl: string; texUrl: string; applicationId: number }
  | { type: "APPROVE_FAILED"; message: string; log?: string }
  | { type: "RESET" };

function initialState(): State {
  return {
    stage: "url",
    url: "",
    pasteVisible: false,
    pasteReason: null,
    pasteText: "",
    scrapeLoading: false,
    scrapeError: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_URL":
      return state.stage === "url" ? { ...state, url: action.url } : state;

    case "TOGGLE_PASTE":
      return state.stage === "url"
        ? { ...state, pasteVisible: true, pasteReason: state.pasteReason ?? "manual" }
        : state;

    case "SET_PASTE_TEXT":
      return state.stage === "url" ? { ...state, pasteText: action.text } : state;

    case "SCRAPE_START":
      return state.stage === "url" ? { ...state, scrapeLoading: true, scrapeError: null } : state;

    case "SCRAPE_SUCCESS":
      // stale response guard: ignore if the user already navigated away from "url" while this
      // request was in flight (the UI also disables navigation during scrapeLoading, so this is
      // belt-and-braces, not the primary defense)
      if (state.stage !== "url") return state;
      return {
        stage: "confirm",
        url: state.url,
        jobDescription: action.description,
        tailorLoading: false,
        tailorError: null,
      };

    case "SCRAPE_FAILED":
      if (state.stage !== "url") return state;
      return {
        ...state,
        scrapeLoading: false,
        scrapeError: action.message,
        pasteVisible: true,
        pasteReason: "failed",
      };

    case "CONTINUE_WITH_PASTE":
      if (state.stage !== "url" || state.pasteText.trim().length === 0) return state;
      return {
        stage: "confirm",
        url: state.url,
        jobDescription: state.pasteText,
        tailorLoading: false,
        tailorError: null,
      };

    case "SET_JOB_DESCRIPTION":
      return state.stage === "confirm" ? { ...state, jobDescription: action.text } : state;

    case "BACK_TO_URL":
      // carries the current description back into the paste box (already revealed) so editing
      // isn't lost just because the user wants to change the source URL
      if (state.stage !== "confirm") return state;
      return {
        stage: "url",
        url: state.url,
        pasteVisible: true,
        pasteReason: "manual",
        pasteText: state.jobDescription,
        scrapeLoading: false,
        scrapeError: null,
      };

    case "TAILOR_START":
      if (state.stage === "confirm" || state.stage === "review") {
        return { ...state, tailorLoading: true, tailorError: null };
      }
      return state;

    case "TAILOR_SUCCESS":
      if (state.stage !== "confirm" && state.stage !== "review") return state;
      return {
        stage: "review",
        url: state.url,
        jobDescription: state.jobDescription,
        baseTex: action.data.baseTex,
        tex: action.data.tex,
        company: action.data.company,
        role: action.data.role,
        violations: action.data.violations,
        report: action.data.report,
        tailorLoading: false,
        tailorError: null,
        feedbackText: "",
        approveLoading: false,
        approveError: null,
        compileLog: null,
      };

    case "TAILOR_FAILED":
      if (state.stage === "confirm" || state.stage === "review") {
        return { ...state, tailorLoading: false, tailorError: action.message };
      }
      return state;

    case "SET_COMPANY":
      return state.stage === "review" ? { ...state, company: action.value } : state;

    case "SET_ROLE":
      return state.stage === "review" ? { ...state, role: action.value } : state;

    case "SET_FEEDBACK_TEXT":
      return state.stage === "review" ? { ...state, feedbackText: action.value } : state;

    case "APPROVE_START":
      return state.stage === "review"
        ? { ...state, approveLoading: true, approveError: null, compileLog: null }
        : state;

    case "APPROVE_SUCCESS":
      if (state.stage !== "review") return state;
      return {
        stage: "done",
        url: state.url,
        company: state.company,
        role: state.role,
        pdfUrl: action.pdfUrl,
        texUrl: action.texUrl,
        applicationId: action.applicationId,
      };

    case "APPROVE_FAILED":
      if (state.stage !== "review") return state;
      return { ...state, approveLoading: false, approveError: action.message, compileLog: action.log ?? null };

    case "RESET":
      return initialState();

    default:
      return state;
  }
}

type ReviewTab = "latex" | "pdf";

const REVIEW_TABS: { id: ReviewTab; label: string }[] = [
  { id: "latex", label: "LaTeX diff" },
  { id: "pdf", label: "PDF preview" },
];

const STEPS: { stage: Stage; label: string }[] = [
  { stage: "url", label: "Job posting" },
  { stage: "confirm", label: "Confirm description" },
  { stage: "review", label: "Review & approve" },
  { stage: "done", label: "Done" },
];

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  return res.json().catch(() => null);
}

/**
 * Whether this response means "your session is gone" rather than "the request failed".
 *
 * Checked at every step of the flow, not just the first: a session can expire during the ~20s a
 * tailoring run takes, and showing "Could not fetch this job posting" for an expired cookie sends
 * the user off debugging the wrong thing entirely.
 */
function isUnauthorized(res: Response): boolean {
  return res.status === 401;
}

// mirrors the shape checks every other tailor-response field already gets -- without this, a 200
// with a missing/malformed `report` would sail past `res.ok` and crash ReportCard's unguarded
// destructure at render time (no error.tsx boundary exists to catch it). `scoreAfter: 0` is a
// legitimate value, so check `typeof === "number"`, never truthiness.
function isValidAtsReport(value: unknown): value is AtsReport {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.scoreBefore === "number" &&
    typeof r.scoreAfter === "number" &&
    Array.isArray(r.keywords) &&
    Array.isArray(r.matchedBefore) &&
    Array.isArray(r.matchedAfter) &&
    Array.isArray(r.missing) &&
    Array.isArray(r.missingNotClaimable) &&
    Array.isArray(r.fabricatedAdded)
  );
}

export default function NewApplicationPage() {
  const { isAuthenticated } = useRequireSession();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [fieldErrors, setFieldErrors] = useState<{ company?: string; role?: string }>({});
  // B2 fabrication gate: explicit user acknowledgement required before Approve is allowed when
  // the report flags fabricatedAdded terms. Reset on every fresh tailor result (below) so an
  // acknowledgement never silently carries over onto a different draft's fabricated terms.
  const [fabricationAck, setFabricationAck] = useState(false);
  // which review pane is showing. Deliberately not in the reducer: it's view state, not a step in
  // the flow, and it must survive a regenerate so you stay on the pane you were reading.
  const [reviewTab, setReviewTab] = useState<ReviewTab>("latex");

  // WAI-ARIA tabs: left/right move between tabs and take focus with them
  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();

    const current = REVIEW_TABS.findIndex((t) => t.id === reviewTab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = REVIEW_TABS[(current + step + REVIEW_TABS.length) % REVIEW_TABS.length];

    setReviewTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  }

  // mirrors the server's scrape/tailor/approve progress into the DevTools console, live. Dev only:
  // this exists to make the ~70s tailoring call legible while it runs, not to ship to users.
  // Failures are deliberately silent -- a missing log stream must never disturb the actual flow.
  useEffect(() => {
    if (!isAuthenticated || process.env.NODE_ENV !== "development") return;

    const source = new EventSource("/api/logs");
    source.onmessage = (event) => {
      try {
        console.log(JSON.parse(event.data));
      } catch {
        console.log(event.data);
      }
    };

    return () => source.close();
  }, [isAuthenticated]);

  // guards against setState-via-dispatch after unmount (e.g. user navigates to "/" mid-request) --
  // the fetch itself isn't cancelled, but its result is discarded rather than dispatched.
  //
  // The re-arm on mount is load-bearing, not defensive: useRef preserves its value across React's
  // StrictMode mount/unmount/remount cycle (on by default in the app router since 13.5.1) and
  // across every Fast Refresh, so the initial `true` is only ever applied once. Without setting it
  // back here, the first cleanup latches it to false forever and every fetch result is silently
  // discarded -- the page sticks on "Fetching…"/"Tailoring…" with no error, in dev only.
  const router = useRouter();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // moves keyboard/screen-reader focus to the new stage's heading on every stage transition, the
  // single-page-flow equivalent of managing focus on route change
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [state.stage]);

  const companyRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLInputElement>(null);

  async function handleFetchPosting() {
    if (state.stage !== "url") return;
    const trimmed = state.url.trim();
    if (!trimmed) return;
    dispatch({ type: "SCRAPE_START" });
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await safeJson(res);
      if (isUnauthorized(res)) { router.push("/signin"); return; }
      if (!mountedRef.current) return;
      if (res.ok && typeof data?.description === "string") {
        dispatch({ type: "SCRAPE_SUCCESS", description: data.description });
      } else {
        const message = typeof data?.error === "string" ? data.error : "Could not fetch this job posting.";
        dispatch({ type: "SCRAPE_FAILED", message });
      }
    } catch {
      if (!mountedRef.current) return;
      dispatch({ type: "SCRAPE_FAILED", message: "Network error while fetching the posting." });
    }
  }

  async function runTailor(opts: { feedback?: string; previousTex?: string }) {
    if (state.stage !== "confirm" && state.stage !== "review") return;
    const jobDescription = state.jobDescription;
    dispatch({ type: "TAILOR_START" });
    try {
      const res = await fetch("/api/tailor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription, ...opts }),
      });
      const data = await safeJson(res);
      if (isUnauthorized(res)) { router.push("/signin"); return; }
      if (!mountedRef.current) return;
      if (
        res.ok &&
        data &&
        typeof data.tex === "string" &&
        typeof data.baseTex === "string" &&
        typeof data.company === "string" &&
        typeof data.role === "string" &&
        isValidAtsReport(data.report)
      ) {
        // fresh tailor output replaces company/role, so a stale "required" error from a previous
        // approve attempt must not linger next to a now-valid field
        setFieldErrors({});
        // a new draft may have different (or no) fabricated terms -- never carry a prior
        // acknowledgement forward onto content the user hasn't seen yet
        setFabricationAck(false);
        dispatch({
          type: "TAILOR_SUCCESS",
          data: {
            tex: data.tex,
            baseTex: data.baseTex,
            company: data.company,
            role: data.role,
            violations: Array.isArray(data.violations) ? (data.violations as TailorViolation[]) : [],
            report: data.report,
          },
        });
      } else {
        const message = typeof data?.error === "string" ? data.error : "Failed to tailor the resume.";
        dispatch({ type: "TAILOR_FAILED", message });
      }
    } catch {
      if (!mountedRef.current) return;
      dispatch({ type: "TAILOR_FAILED", message: "Network error while tailoring the resume." });
    }
  }

  function validateBeforeApprove(): boolean {
    if (state.stage !== "review") return false;
    const errors: { company?: string; role?: string } = {};
    if (!state.company.trim()) errors.company = "Company name is required.";
    if (!state.role.trim()) errors.role = "Role is required.";
    setFieldErrors(errors);
    if (errors.company) companyRef.current?.focus();
    else if (errors.role) roleRef.current?.focus();
    return Object.keys(errors).length === 0;
  }

  async function handleApprove() {
    if (state.stage !== "review") return;
    if (!validateBeforeApprove()) return;
    // B2 fabrication gate: a fabricated skill must never sail through to compile/PDF silently --
    // require an explicit acknowledgement first. The Approve button is also disabled for this
    // same condition below; this is defense-in-depth, not the only guard.
    if (state.report.fabricatedAdded.length > 0 && !fabricationAck) return;
    dispatch({ type: "APPROVE_START" });
    try {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tex: state.tex,
          company: state.company,
          role: state.role,
          url: state.url,
          report: state.report,
        }),
      });
      const data = await safeJson(res);
      if (isUnauthorized(res)) { router.push("/signin"); return; }
      if (!mountedRef.current) return;
      const application = data?.application as { id?: number } | undefined;
      if (res.ok && typeof data?.pdfUrl === "string" && typeof application?.id === "number") {
        dispatch({
          type: "APPROVE_SUCCESS",
          pdfUrl: data.pdfUrl,
          texUrl: `/api/files/${application.id}/tex`,
          applicationId: application.id,
        });
      } else {
        const message = typeof data?.error === "string" ? data.error : "Failed to compile the resume.";
        const log = typeof data?.log === "string" ? data.log : undefined;
        dispatch({ type: "APPROVE_FAILED", message, log });
      }
    } catch {
      if (!mountedRef.current) return;
      dispatch({ type: "APPROVE_FAILED", message: "Network error while approving the resume." });
    }
  }

  const stageIndex = STEPS.findIndex((s) => s.stage === state.stage);
  // any in-flight request in the current stage -- used to disable cross-stage navigation so a
  // stale response can never land on a stage the user already left
  const busy =
    (state.stage === "url" && state.scrapeLoading) ||
    (state.stage === "confirm" && state.tailorLoading) ||
    (state.stage === "review" && (state.tailorLoading || state.approveLoading));

  if (!isAuthenticated) {
    return <AuthGateLoading heading="New Application" label="Checking session" />;
  }

  return (
    <main className="na-root">
      <ol className="na-steps" aria-label="Application progress">
        {STEPS.map((step, i) => (
          <li
            key={step.stage}
            className={`na-step${i === stageIndex ? " na-step--current" : ""}${
              i < stageIndex ? " na-step--done" : ""
            }`}
            aria-current={i === stageIndex ? "step" : undefined}
          >
            <span className="na-step-index" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="na-step-label">{step.label}</span>
          </li>
        ))}
      </ol>

      {state.stage === "url" && (
        <section className="na-section">
          <h1 ref={headingRef} tabIndex={-1} className="na-heading">
            Start a new application
          </h1>
          <div className="na-field">
            <label htmlFor="job-url">Job posting URL</label>
            <input
              id="job-url"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://company.com/careers/role"
              value={state.url}
              onChange={(e) => dispatch({ type: "SET_URL", url: e.target.value })}
              disabled={state.scrapeLoading}
            />
          </div>
          <div className="na-actions">
            <button
              type="button"
              className="na-btn na-btn--primary"
              onClick={handleFetchPosting}
              disabled={state.scrapeLoading || state.url.trim().length === 0}
            >
              {state.scrapeLoading ? "Fetching…" : "Fetch posting"}
            </button>
            {!state.pasteVisible && (
              <button
                type="button"
                className="na-link-btn"
                onClick={() => dispatch({ type: "TOGGLE_PASTE" })}
              >
                Paste instead
              </button>
            )}
          </div>

          {state.scrapeError && (
            <p className="na-error" role="alert">
              {state.scrapeError}
            </p>
          )}

          {state.pasteVisible && (
            <div className="na-field na-paste-box">
              <label htmlFor="paste-description">
                {state.pasteReason === "failed"
                  ? "Couldn't extract this site — paste the job description"
                  : "Paste the job description"}
              </label>
              <textarea
                id="paste-description"
                rows={10}
                value={state.pasteText}
                onChange={(e) => dispatch({ type: "SET_PASTE_TEXT", text: e.target.value })}
              />
              <div className="na-actions">
                <button
                  type="button"
                  className="na-btn na-btn--primary"
                  onClick={() => dispatch({ type: "CONTINUE_WITH_PASTE" })}
                  disabled={state.pasteText.trim().length === 0}
                >
                  Continue
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {state.stage === "confirm" && (
        <section className="na-section">
          <h1 ref={headingRef} tabIndex={-1} className="na-heading">
            Confirm the job description
          </h1>
          <div className="na-field">
            <span className="na-readonly-label">Source URL</span>
            <p className="na-readonly-value">{state.url || "(pasted manually — no URL)"}</p>
          </div>
          <div className="na-field">
            <label htmlFor="confirm-description">Job description</label>
            <textarea
              id="confirm-description"
              rows={14}
              value={state.jobDescription}
              onChange={(e) => dispatch({ type: "SET_JOB_DESCRIPTION", text: e.target.value })}
              disabled={state.tailorLoading}
            />
          </div>

          {state.tailorError && (
            <p className="na-error" role="alert">
              {state.tailorError}
            </p>
          )}
          {state.tailorLoading && (
            <div className="na-progress">
              <p className="na-progress-note" role="status">
                Tailoring your resume — this usually takes 60–100 seconds…
              </p>
              <div className="na-progress-track" aria-hidden="true">
                <div className="na-progress-bar" />
              </div>
            </div>
          )}

          <div className="na-actions">
            <button
              type="button"
              className="na-btn na-btn--secondary"
              onClick={() => dispatch({ type: "BACK_TO_URL" })}
              disabled={busy}
            >
              Back
            </button>
            <button
              type="button"
              className="na-btn na-btn--primary"
              onClick={() => runTailor({})}
              disabled={state.tailorLoading || state.jobDescription.trim().length === 0}
            >
              {state.tailorLoading ? "Tailoring…" : "Tailor resume"}
            </button>
          </div>
        </section>
      )}

      {state.stage === "review" && (
        <section className="na-section">
          <h1 ref={headingRef} tabIndex={-1} className="na-heading">
            Review before you apply
          </h1>

          <p className="na-eyebrow">Application details</p>
          <div className="na-review-fields">
            <div className="na-field">
              <label htmlFor="company">Company</label>
              <input
                id="company"
                ref={companyRef}
                type="text"
                autoComplete="organization"
                value={state.company}
                onChange={(e) => {
                  dispatch({ type: "SET_COMPANY", value: e.target.value });
                  setFieldErrors((prev) => ({ ...prev, company: undefined }));
                }}
                aria-invalid={fieldErrors.company ? true : undefined}
                aria-describedby={fieldErrors.company ? "company-error" : undefined}
              />
              {fieldErrors.company && (
                <p id="company-error" className="na-field-error">
                  {fieldErrors.company}
                </p>
              )}
            </div>
            <div className="na-field">
              <label htmlFor="role">Role</label>
              <input
                id="role"
                ref={roleRef}
                type="text"
                autoComplete="organization-title"
                value={state.role}
                onChange={(e) => {
                  dispatch({ type: "SET_ROLE", value: e.target.value });
                  setFieldErrors((prev) => ({ ...prev, role: undefined }));
                }}
                aria-invalid={fieldErrors.role ? true : undefined}
                aria-describedby={fieldErrors.role ? "role-error" : undefined}
              />
              {fieldErrors.role && (
                <p id="role-error" className="na-field-error">
                  {fieldErrors.role}
                </p>
              )}
            </div>
          </div>

          <ReportCard report={state.report} violations={state.violations} />

          <div className="na-tabs" role="tablist" aria-label="Resume review">
            {REVIEW_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={reviewTab === tab.id}
                aria-controls={`panel-${tab.id}`}
                // roving tabindex: the tablist is one stop, arrows move within it
                tabIndex={reviewTab === tab.id ? 0 : -1}
                className={`na-tab${reviewTab === tab.id ? " na-tab--active" : ""}`}
                onClick={() => setReviewTab(tab.id)}
                onKeyDown={handleTabKeyDown}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* both panels stay mounted so the PDF compile starts as a prefetch and each panel
              keeps its own scroll position across switches */}
          <div
            role="tabpanel"
            id="panel-latex"
            aria-labelledby="tab-latex"
            hidden={reviewTab !== "latex"}
          >
            <DiffView baseTex={state.baseTex} tailoredTex={state.tex} violations={state.violations} />
          </div>
          <div
            role="tabpanel"
            id="panel-pdf"
            aria-labelledby="tab-pdf"
            hidden={reviewTab !== "pdf"}
          >
            {/* keyed on the draft: a regenerate remounts the preview, resetting it to its
                loading state without the component reaching for setState inside an effect */}
            <PdfPreview key={state.tex} tex={state.tex} />
          </div>

          {state.approveError && (
            <div className="na-error" role="alert">
              <p>{state.approveError}</p>
              {state.compileLog && (
                <pre className="na-compile-log">{state.compileLog}</pre>
              )}
            </div>
          )}
          {state.tailorError && (
            <p className="na-error" role="alert">
              {state.tailorError}
            </p>
          )}
          {state.tailorLoading && (
            <div className="na-progress">
              <p className="na-progress-note" role="status">
                Re-tailoring your resume — this usually takes 60–100 seconds…
              </p>
              <div className="na-progress-track" aria-hidden="true">
                <div className="na-progress-bar" />
              </div>
            </div>
          )}

          {/* visible seam between "reviewing" content above and "deciding" content below --
              groups the acknowledgement + terminal actions so Approve reads as the page's one
              consequential action, not just another row in the flow */}
          <div className="na-decision">
            <p className="na-eyebrow">Decision</p>
            {state.report.fabricatedAdded.length > 0 && (
              // B2 fabrication gate: Approve stays disabled until this is checked, so a possible
              // fabricated skill can never reach compile/PDF without the user actively confirming
              // they've reviewed it (ReportCard renders the terms themselves as a hard warning above)
              <div className="na-field na-fabrication-ack">
                <label htmlFor="fabrication-ack">
                  <input
                    id="fabrication-ack"
                    type="checkbox"
                    checked={fabricationAck}
                    onChange={(e) => setFabricationAck(e.target.checked)}
                  />
                  <span>
                    I&apos;ve reviewed the possible fabricated skills flagged above and confirm I
                    can genuinely claim them, or will remove them before approving.
                  </span>
                </label>
              </div>
            )}

            <div className="na-actions">
              <button
                type="button"
                className="na-btn na-btn--primary"
                onClick={handleApprove}
                disabled={busy || (state.report.fabricatedAdded.length > 0 && !fabricationAck)}
              >
                {state.approveLoading ? "Compiling…" : "Approve & compile"}
              </button>
              <button
                type="button"
                className="na-btn na-btn--secondary"
                onClick={() => runTailor({})}
                disabled={busy}
              >
                Regenerate
              </button>
            </div>
          </div>

          <div className="na-field na-feedback-box">
            <label htmlFor="feedback">Request changes</label>
            <textarea
              id="feedback"
              rows={3}
              placeholder="e.g. emphasize the Kubernetes work in the second bullet"
              value={state.feedbackText}
              onChange={(e) => dispatch({ type: "SET_FEEDBACK_TEXT", value: e.target.value })}
              disabled={busy}
            />
            <div className="na-actions">
              <button
                type="button"
                className="na-btn na-btn--secondary"
                onClick={() => runTailor({ feedback: state.feedbackText.trim(), previousTex: state.tex })}
                disabled={busy || state.feedbackText.trim().length === 0}
              >
                Send feedback & re-tailor
              </button>
            </div>
          </div>
        </section>
      )}

      {state.stage === "done" && (
        <section className="na-section">
          <h1 ref={headingRef} tabIndex={-1} className="na-heading">
            Application ready
          </h1>
          <p className="na-done-summary">
            {state.role} at {state.company}
          </p>
          <div className="na-actions">
            <a className="na-btn na-btn--primary" href={state.pdfUrl}>
              Download PDF
            </a>
            <a className="na-btn na-btn--secondary" href={state.texUrl}>
              View .tex
            </a>
            <Link className="na-btn na-btn--secondary" href="/applications">
              Go to tracker
            </Link>
            <button type="button" className="na-btn na-btn--secondary" onClick={() => dispatch({ type: "RESET" })}>
              Start another
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
