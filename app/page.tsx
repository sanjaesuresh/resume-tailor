import Link from "next/link";
import type { ReactNode } from "react";

const latexLines = [
  "\\resumeSubheading",
  "  {Initech}{Sept. 2025 -- Dec. 2025}",
  "  {Software Engineer Intern}{Vancouver, BC}",
  "\\resumeItem{Optimized \\textbf{database access}, \\textbf{caching}, and \\textbf{load distribution} with \\textbf{SQLAlchemy}, \\textbf{Redis}, and \\textbf{Kafka} to increase throughput by \\textbf{22\\%} and \\textbf{reduce latency} by \\textbf{12\\%}.}",
];

const diffRows = [
  {
    kind: "removed",
    text: "Optimized database access, caching, and load distribution with SQLAlchemy, Redis, and Kafka to increase throughput by 22% and reduce latency by 12%.",
  },
  {
    kind: "added",
    text: "Tuned checkout APIs for a high-volume logistics platform using Python, PostgreSQL, Redis, and Kafka, lifting throughput 22% and reducing p95 latency 12%.",
  },
  {
    kind: "blocked",
    text: "Deployed Kubernetes workloads for shipment routing services.",
    note: "Rejected: Kubernetes is not in the resume or skills whitelist.",
  },
];

const atsKeywords = [
  { term: "Python", state: "matched" },
  { term: "PostgreSQL", state: "matched" },
  { term: "Redis", state: "matched" },
  { term: "Kafka", state: "matched" },
  { term: "API latency", state: "matched" },
  { term: "Kubernetes", state: "blocked" },
];

function StepCopy({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <div className="ld-step-copy">
      <p className="na-eyebrow">{label}</p>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main className="ld-root ld-root--guide">
      <section className="ld-hero ld-hero--guide" aria-labelledby="landing-title">
        <div className="ld-intro">
          <p className="na-eyebrow">Resume Tailor</p>
          <h1 id="landing-title" className="ld-title">
            How to turn a posting into a verified LaTeX resume.
          </h1>
        </div>
        <div className="ld-hero-note">
          <p>Use it when you want tailoring, but not invented experience.</p>
          <Link href="/signin" className="na-btn na-btn--primary">
            Sign in
          </Link>
        </div>
      </section>

      <section className="ld-guide" aria-label="How to use Resume Tailor">
        <article className="ld-guide-row">
          <StepCopy label="Start" title="Paste the job posting URL.">
            The app extracts the role, company, and keyword targets before touching your resume.
          </StepCopy>
          <div className="ld-posting" aria-label="Posting extraction">
            <span id="sample-url-label" className="ld-label">
              Job posting URL
            </span>
            <div
              className="ld-url"
              role="textbox"
              aria-readonly="true"
              aria-labelledby="sample-url-label"
            >
              https://careers.northstar.example/backend-engineer
            </div>
            <div className="ld-scrape">
              <span>Northstar Logistics</span>
              <span>Backend Engineer</span>
              <span>Python · PostgreSQL · Redis · Kafka · API latency</span>
            </div>
          </div>
        </article>

        <article className="ld-guide-row">
          <StepCopy label="Tailor" title="Let it rewrite the LaTeX you already trust.">
            Your base resume stays the source of truth; the generated draft is shown as a diff.
          </StepCopy>
          <div className="ld-workbench ld-workbench--guide">
            <div className="ld-panel ld-panel--latex">
              <div className="ld-panel-head">
                <h2>Base resume sample</h2>
                <span>.tex</span>
              </div>
              <pre className="ld-code">
                {latexLines.map((line, index) => (
                  <code key={line}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {line}
                    {"\n"}
                  </code>
                ))}
              </pre>
            </div>

            <div className="ld-panel ld-panel--diff">
              <div className="ld-panel-head">
                <h2>Generated diff</h2>
                <span>review</span>
              </div>
              <ol className="ld-diff" aria-label="Tailored resume diff">
                {diffRows.map((row) => (
                  <li key={row.text} className={`ld-diff-row ld-diff-row--${row.kind}`}>
                    <code>
                      <span aria-hidden="true">
                        {row.kind === "removed" ? "-" : row.kind === "blocked" ? "!" : "+"}
                      </span>
                      {row.text}
                    </code>
                    {row.note && <p>{row.note}</p>}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </article>

        <article className="ld-guide-row">
          <StepCopy label="Guard" title="Check every new capitalized claim.">
            If a term is not in the resume or your skills whitelist, code blocks it before PDF.
          </StepCopy>
          <div className="ld-panel ld-panel--validator">
            <div className="ld-panel-head">
              <h2>Validator</h2>
              <span>lib/validator.ts</span>
            </div>
            <p className="ld-verdict">Blocked before PDF</p>
            <p className="ld-fact">New capitalized term: Kubernetes</p>
            <p className="ld-fact">Base resume: no match</p>
            <p className="ld-fact">Skills whitelist: no match</p>
          </div>
        </article>

        <article className="ld-guide-row">
          <StepCopy label="Review" title="Read the evidence, then approve.">
            Check the ATS keyword report and compiled proof before the application is saved.
          </StepCopy>
          <div className="ld-review ld-review--guide" aria-label="Review outputs">
            <div className="ld-panel">
              <div className="ld-panel-head">
                <h2>ATS keyword report</h2>
                <span className="na-num">86/100</span>
              </div>
              <div className="ld-score" aria-label="ATS score 86 out of 100">
                <span style={{ width: "86%" }} />
              </div>
              <ul className="ld-keywords">
                {atsKeywords.map((keyword) => (
                  <li key={keyword.term} className={`ld-keyword ld-keyword--${keyword.state}`}>
                    {keyword.term}
                  </li>
                ))}
              </ul>
            </div>

            <div className="ld-panel ld-pdf" aria-label="Compiled PDF preview">
              <div className="ld-panel-head">
                <h2>Compiled PDF</h2>
                <span>proof</span>
              </div>
              <div className="ld-paper">
                <p className="ld-paper-name">Jane Doe</p>
                <p>Backend Engineer · Northstar Logistics</p>
                <hr />
                <p>
                  Tuned checkout APIs using Python, PostgreSQL, Redis, and Kafka, lifting
                  throughput 22% and reducing p95 latency 12%.
                </p>
              </div>
            </div>
          </div>
        </article>

        <article className="ld-guide-row">
          <StepCopy label="Track" title="Keep approved applications organized.">
            Each approved run lands in the tracker with status, notes, and downloads.
          </StepCopy>
          <div className="ld-tracker" aria-labelledby="tracker-heading">
            <div className="ld-panel-head">
              <h2 id="tracker-heading">Approved applications</h2>
              <span>tracker</span>
            </div>
            <div className="ld-table-wrap">
              <table className="ld-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Notes</th>
                    <th>Downloads</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Northstar Logistics</td>
                    <td>Backend Engineer</td>
                    <td>Approved</td>
                    <td>Follow up Tuesday</td>
                    <td>PDF · .tex</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}
