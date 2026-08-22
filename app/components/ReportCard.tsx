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
  // named to carry the actual stakes (an unverifiable claim on a real job application), not a
  // generic-severity label that reads the same as a cosmetic issue like "Bullet too long"
  "non-whitelisted-keyword": "Possible fabricated skill",
  "unparseable-response": "Response error",
};

type Coverage = "matched" | "fabricated" | "missing-claimable" | "not-claimable" | "unknown";

// one glyph + one screen-reader phrase per coverage state, always paired with a color (never
// color alone) -- the same rule DiffView's +/- markers already follow
const COVERAGE_META: Record<Coverage, { glyph: string; label: string }> = {
  matched: { glyph: "✓", label: "matched" }, // check mark
  fabricated: { glyph: "!", label: "possibly fabricated -- review before approving" },
  "missing-claimable": { glyph: "·", label: "missing, still claimable" }, // middle dot
  "not-claimable": { glyph: "×", label: "not claimable -- not on your skills whitelist" }, // multiplication sign
  unknown: { glyph: "?", label: "status unavailable" },
};

/**
 * Signature "coverage grid": every keyword the ATS extractor found (lib/ats.ts's AtsReport)
 * rendered as one cell, colored and glyphed by its real verified status -- never a fabricated
 * or invented category, purely a classification of the report's own arrays.
 */
function classify(
  keyword: string,
  sets: {
    matchedHonest: string[];
    fabricated: string[];
    missingClaimable: string[];
    missingNotClaimable: string[];
  }
): Coverage {
  // order matters: a fabricated term is technically present in matchedAfter but must never read
  // as a plain "matched" cell, so it's checked first
  if (sets.fabricated.includes(keyword)) return "fabricated";
  if (sets.matchedHonest.includes(keyword)) return "matched";
  if (sets.missingNotClaimable.includes(keyword)) return "not-claimable";
  if (sets.missingClaimable.includes(keyword)) return "missing-claimable";
  // defensive fallback only -- every real keyword should land in one of the four buckets above;
  // this never fabricates a status, it just admits the report's arrays didn't account for it
  return "unknown";
}

function CoverageGrid({ keywords, coverageOf }: { keywords: string[]; coverageOf: (kw: string) => Coverage }) {
  return (
    <ul className="rc-grid" aria-label={`Keyword coverage, ${keywords.length} keyword${keywords.length === 1 ? "" : "s"}`}>
      {keywords.map((kw) => {
        const coverage = coverageOf(kw);
        const meta = COVERAGE_META[coverage];
        return (
          <li key={kw} className={`rc-cell rc-cell--${coverage}`}>
            <span className="rc-cell-mark" aria-hidden="true">
              {meta.glyph}
            </span>
            <span>
              {kw}
              <span className="visually-hidden"> — {meta.label}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Review-gate summary: validator warnings (if any), the before/after ATS keyword-match score,
 * and the keyword coverage grid -- the honest "not claimed" cells are presented as intentional
 * (never fabricating a skill), not as a shortfall.
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
    fabricatedAdded = [],
  } = report ?? {};
  const scoresAvailable = typeof scoreBefore === "number" && typeof scoreAfter === "number";
  // "missing" already includes missingNotClaimable -- split out the subset Claude could still add
  // (on the whitelist) so the two lists never overlap and each reads as a distinct, honest signal
  const missingClaimable = missing.filter((k) => !missingNotClaimable.includes(k));
  const delta = scoresAvailable ? scoreAfter - scoreBefore : 0;
  // a fabricated term must never render as a legitimate "Matched" cell -- it gets its own hard
  // warning block instead (below) plus a hazard-ringed grid cell, never a plain matched cell
  const matchedAfterHonest = matchedAfter.filter((k) => !fabricatedAdded.includes(k));

  const coverageOf = (kw: string) =>
    classify(kw, {
      matchedHonest: matchedAfterHonest,
      fabricated: fabricatedAdded,
      missingClaimable,
      missingNotClaimable,
    });

  return (
    <section aria-labelledby="report-heading" className="rc-root">
      <h3 id="report-heading" className="rc-heading">
        ATS match report
      </h3>

      {fabricatedAdded.length > 0 && (
        // deliberately styled harder than `.rc-violations` (which reads as a routine, fixable
        // validator warning) -- a fabricated skill is not a formatting nit, it's an unclaimable
        // skill about to go on a real job application. Driven by --na-danger tokens (globals.css)
        // rather than hardcoded hex, so it stays legible and on-palette in dark mode too.
        <div className="rc-fabrication-warning" role="alert">
          <p className="rc-fabrication-warning-title">
            {fabricatedAdded.length} possible fabricated skill{fabricatedAdded.length === 1 ? "" : "s"} detected
          </p>
          <p className="rc-fabrication-warning-body">
            These terms appear in the tailored resume but were not in your original resume and are
            not on your skills whitelist -- they cannot be verified as skills you actually have.
            Remove them or add them to your whitelist before approving. They&apos;re also flagged
            in the coverage grid below.
          </p>
        </div>
      )}

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
            <span className="rc-num">
              {delta > 0 ? "+" : ""}
              {delta}
            </span>{" "}
            point{Math.abs(delta) === 1 ? "" : "s"} {delta >= 0 ? "gained" : "lost"} out of{" "}
            <span className="rc-num">{keywords.length}</span> extracted keyword
            {keywords.length === 1 ? "" : "s"}.
          </p>

          {missing.length === 0 && (
            <p className="rc-all-matched">All extracted keywords are present in the tailored resume.</p>
          )}

          <div>
            <p id="coverage-heading" className="rc-coverage-heading">
              Keyword coverage ({matchedAfterHonest.length} of {keywords.length} matched)
            </p>
            <ul className="rc-legend">
              {(["matched", "missing-claimable", "not-claimable", "fabricated"] as Coverage[]).map((c) => (
                <li key={c} className="rc-legend-item">
                  <span className={`rc-legend-mark rc-cell--${c}`} aria-hidden="true">
                    {COVERAGE_META[c].glyph}
                  </span>
                  {COVERAGE_META[c].label}
                </li>
              ))}
            </ul>
            <CoverageGrid keywords={keywords} coverageOf={coverageOf} />
          </div>
        </>
      )}
    </section>
  );
}
