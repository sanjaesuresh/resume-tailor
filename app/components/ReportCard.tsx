"use client";

import type { AtsReport } from "@/lib/ats";
import type { TailorViolation } from "@/lib/tailor";

interface ReportCardProps {
  report: AtsReport;
  violations: TailorViolation[];
}

// human labels for the validator's closed rule set (lib/validator.ts) plus the tailoring
// module's own parse-failure tag (lib/tailor.ts) -- kept local since this is presentation only
const RULE_LABELS: Record<TailorViolation["rule"], string> = {
  "removed-line": "Content removed",
  "bullet-too-long": "Bullet too long",
  "unescaped-percent": "Unescaped %",
  "non-whitelisted-keyword": "Unverified keyword",
  "unparseable-response": "Response error",
};

function KeywordChips({ keywords, tone }: { keywords: string[]; tone: "matched" | "missing" | "unclaimed" }) {
  return (
    <ul className={`rc-chip-list rc-chip-list--${tone}`}>
      {keywords.map((kw) => (
        <li key={kw} className={`rc-chip rc-chip--${tone}`}>
          {kw}
        </li>
      ))}
    </ul>
  );
}

/**
 * Review-gate summary: validator warnings (if any), the before/after ATS keyword-match score,
 * and the matched/missing keyword breakdown -- the honest "not claimed" list is presented as
 * intentional (never fabricating a skill), not as a shortfall.
 */
export default function ReportCard({ report, violations }: ReportCardProps) {
  // defensive: a malformed/partial `report` should render a clear fallback rather than throw --
  // arrays default to empty, but scoreBefore/scoreAfter are checked for presence explicitly below
  // since `0` is a legitimate score and must not be treated as "missing"
  const {
    keywords = [],
    matchedAfter = [],
    scoreBefore,
    scoreAfter,
    missing = [],
    missingNotClaimable = [],
  } = report ?? {};
  const scoresAvailable = typeof scoreBefore === "number" && typeof scoreAfter === "number";
  // "missing" already includes missingNotClaimable -- split out the subset Claude could still add
  // (on the whitelist) so the two lists never overlap and each reads as a distinct, honest signal
  const missingClaimable = missing.filter((k) => !missingNotClaimable.includes(k));
  const delta = scoresAvailable ? scoreAfter - scoreBefore : 0;

  return (
    <section aria-labelledby="report-heading" className="rc-root">
      <h3 id="report-heading" className="rc-heading">
        ATS match report
      </h3>

      {violations.length > 0 && (
        <div className="rc-violations" role="alert">
          <p className="rc-violations-title">
            {violations.length} validator warning{violations.length === 1 ? "" : "s"} on this draft
          </p>
          <ul className="rc-violations-list">
            {violations.map((v, i) => (
              <li key={i}>
                <span className="rc-violation-rule">{RULE_LABELS[v.rule]}</span>
                {v.line ? ` (line ${v.line})` : ""}: {v.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!scoresAvailable ? (
        <p className="rc-empty">Report unavailable — the tailoring response didn&apos;t include a valid ATS report.</p>
      ) : keywords.length === 0 ? (
        <p className="rc-empty">No ATS keywords could be extracted from this job description.</p>
      ) : (
        <>
          <div className="rc-scores">
            <div className="rc-score">
              <label htmlFor="score-before">Before</label>
              <progress id="score-before" max={100} value={scoreBefore}>
                {scoreBefore}%
              </progress>
              <span className="rc-score-value">{scoreBefore}%</span>
            </div>
            <div className="rc-score">
              <label htmlFor="score-after">After</label>
              <progress id="score-after" max={100} value={scoreAfter}>
                {scoreAfter}%
              </progress>
              <span className="rc-score-value">{scoreAfter}%</span>
            </div>
          </div>
          <p className="rc-delta">
            {delta > 0 ? "+" : ""}
            {delta} point{Math.abs(delta) === 1 ? "" : "s"} {delta >= 0 ? "gained" : "lost"} out of{" "}
            {keywords.length} extracted keyword{keywords.length === 1 ? "" : "s"}.
          </p>

          <h4 className="rc-subheading">
            Matched ({matchedAfter.length} of {keywords.length})
          </h4>
          {matchedAfter.length === 0 ? (
            <p className="rc-empty">No keywords matched yet.</p>
          ) : (
            <KeywordChips keywords={matchedAfter} tone="matched" />
          )}

          {missing.length === 0 ? (
            <p className="rc-all-matched">All extracted keywords are present in the tailored resume.</p>
          ) : (
            <>
              {missingClaimable.length > 0 && (
                <>
                  <h4 className="rc-subheading">Still missing ({missingClaimable.length})</h4>
                  <KeywordChips keywords={missingClaimable} tone="missing" />
                </>
              )}
              {missingNotClaimable.length > 0 && (
                <>
                  <h4 className="rc-subheading">
                    Not claimed ({missingNotClaimable.length})
                  </h4>
                  <p className="rc-unclaimed-note">
                    Not added because they aren&apos;t on your skills whitelist -- never fabricated.
                  </p>
                  <KeywordChips keywords={missingNotClaimable} tone="unclaimed" />
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
