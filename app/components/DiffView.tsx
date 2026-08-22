"use client";

import { useMemo, useRef } from "react";
import { diffLines, type Change } from "diff";
import type { TailorViolation } from "@/lib/tailor";

interface DiffViewProps {
  baseTex: string;
  tailoredTex: string;
  violations: TailorViolation[];
}

interface DiffLine {
  key: string;
  kind: "added" | "removed" | "same";
  text: string;
  /** 1-indexed line number in tailoredTex, matching TailorViolation.line (lib/validator.ts's
      lineNumberAt) -- undefined for "removed" rows, which exist only in baseTex and so can
      never be the anchor for a violation reported against the tailored output. */
  tailoredLine?: number;
}

// human labels for the validator's closed rule set (lib/validator.ts) plus the tailoring
// module's own parse-failure tag (lib/tailor.ts) -- duplicated from ReportCard.tsx rather than
// shared, matching this codebase's existing convention (see StatusSelect.tsx / page.tsx's
// visuallyHiddenStyle) of keeping each UI-only file self-contained
const RULE_LABELS: Record<TailorViolation["rule"], string> = {
  "removed-line": "Content removed",
  "bullet-too-long": "Bullet too long",
  "unescaped-percent": "Unescaped %",
  "non-whitelisted-keyword": "Possible fabricated skill",
  "unparseable-response": "Response error",
};

// flattens jsdiff's per-hunk Change[] into one row per source line, each tagged with its own
// add/remove/same kind (for the leading +/-/space marker, never color alone) and, for any line
// that actually exists in the tailored output, the 1-indexed tailored-line number a validator
// violation would reference -- lets each row look itself up in the violations-by-line map below.
function toLines(changes: Change[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let tailoredLineNo = 0;
  changes.forEach((part, partIndex) => {
    const kind: DiffLine["kind"] = part.added ? "added" : part.removed ? "removed" : "same";
    // diffLines keeps the trailing "\n" on every line, so splitting on "\n" leaves one bogus
    // empty entry at the end of every part except the last -- drop it rather than render a blank row
    const partLines = part.value.split("\n");
    if (partLines[partLines.length - 1] === "") partLines.pop();
    partLines.forEach((text, lineIndex) => {
      // "removed" lines came from baseTex and were never emitted into tailoredTex, so they never
      // advance (or hold) a tailored-line number
      if (kind !== "removed") tailoredLineNo += 1;
      lines.push({
        key: `${partIndex}-${lineIndex}`,
        kind,
        text,
        tailoredLine: kind === "removed" ? undefined : tailoredLineNo,
      });
    });
  });
  return lines;
}

const SIGN: Record<DiffLine["kind"], string> = { added: "+", removed: "-", same: " " };

/**
 * Line-level diff of the base resume against the tailored one, unified view (jsdiff diffLines).
 * Added/removed lines are marked with both color AND a leading +/- character so the distinction
 * never depends on color perception alone.
 *
 * Signature "correction marginalia" treatment: any validator violation that carries a `line`
 * (lib/tailor.ts's TailorViolation) is anchored to that row and rendered as a proofreader's
 * margin note, connected back to the flagged line by a hairline rule. Violations without a line
 * (removed-line, non-whitelisted-keyword, unparseable-response -- see lib/validator.ts) fall
 * back to a marginalia note pinned above the diff, so nothing is ever silently dropped.
 */
export default function DiffView({ baseTex, tailoredTex, violations }: DiffViewProps) {
  // recomputed only when the two tex strings actually change (regenerate/request-changes), not on
  // every render of the parent review stage (e.g. while typing in the company/role fields)
  const lines = useMemo(() => toLines(diffLines(baseTex, tailoredTex)), [baseTex, tailoredTex]);
  const hasChanges = useMemo(() => lines.some((l) => l.kind !== "same"), [lines]);

  const violationsByLine = useMemo(() => {
    const map = new Map<number, TailorViolation[]>();
    for (const v of violations) {
      if (typeof v.line !== "number") continue;
      const existing = map.get(v.line);
      if (existing) existing.push(v);
      else map.set(v.line, [v]);
    }
    return map;
  }, [violations]);

  // one mark per changed line, positioned by its fraction through the document -- the same idea
  // as an editor's overview ruler: where the changes are, without scrolling to find them.
  // Consecutive changed lines of the same kind collapse into one taller mark so a rewritten block
  // reads as a block rather than a dotted column.
  const rulerMarks = useMemo(() => {
    const marks: { key: string; kind: "added" | "removed"; top: number; height: number }[] = [];
    if (lines.length === 0) return marks;

    for (let i = 0; i < lines.length; i++) {
      const kind = lines[i].kind;
      if (kind === "same") continue;
      let run = 1;
      while (i + run < lines.length && lines[i + run].kind === kind) run++;
      marks.push({
        key: lines[i].key,
        kind,
        top: (i / lines.length) * 100,
        height: (run / lines.length) * 100,
      });
      i += run - 1;
    }
    return marks;
  }, [lines]);

  const preRef = useRef<HTMLPreElement>(null);

  // click the ruler to jump to that point in the diff, the way the editor equivalent behaves
  function scrollToFraction(event: React.MouseEvent<HTMLDivElement>) {
    const pre = preRef.current;
    if (!pre) return;
    const { top, height } = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - top) / height;
    pre.scrollTo({ top: fraction * pre.scrollHeight - pre.clientHeight / 2 });
  }

  const unanchoredViolations = useMemo(
    () => violations.filter((v) => typeof v.line !== "number"),
    [violations]
  );

  return (
    <section aria-labelledby="diff-heading" className="dv-root">
      <h3 id="diff-heading" className="dv-heading">
        Resume changes
      </h3>
      <p className="dv-legend">
        Base resume compared to the tailored version. Added lines are marked{" "}
        <span className="dv-legend-added">+</span>, removed lines{" "}
        <span className="dv-legend-removed">-</span>.
      </p>

      {unanchoredViolations.length > 0 && (
        <div className="dv-marginalia-top" role="alert">
          {unanchoredViolations.map((v, i) => (
            <p key={i}>
              <span className="dv-note-rule">{RULE_LABELS[v.rule]}</span>: {v.message}
            </p>
          ))}
        </div>
      )}

      {!hasChanges ? (
        <p className="dv-empty">No differences from the base resume yet.</p>
      ) : (
        <div className="dv-scroller">
        <pre className="dv-pre" ref={preRef} tabIndex={0} aria-label="Resume diff, line by line">
          {lines.map((line) => {
            const flagged =
              line.tailoredLine !== undefined ? violationsByLine.get(line.tailoredLine) : undefined;
            return (
              <div
                key={line.key}
                className={`dv-line dv-line--${line.kind}${flagged ? " dv-line--flagged" : ""}`}
              >
                <span className="dv-code">
                  <span className="dv-sign" aria-hidden="true">
                    {SIGN[line.kind]}
                  </span>
                  <span className="dv-text">{line.text.length ? line.text : " "}</span>
                </span>
                {flagged && (
                  <aside className="dv-note" aria-label="Validator note">
                    {flagged.map((v, i) => (
                      <p key={i}>
                        <span className="dv-note-rule">{RULE_LABELS[v.rule]}</span> {v.message}
                      </p>
                    ))}
                  </aside>
                )}
              </div>
            );
          })}
        </pre>

          {/* decorative: the diff itself is the accessible content, and the ruler only restates
              where its marked lines are */}
          <div
            className="dv-ruler"
            aria-hidden="true"
            onClick={scrollToFraction}
            title="Jump to changes"
          >
            {rulerMarks.map((mark) => (
              <span
                key={mark.key}
                className={`dv-ruler-mark dv-ruler-mark--${mark.kind}`}
                style={{ top: `${mark.top}%`, height: `max(2px, ${mark.height}%)` }}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
