"use client";

import { useMemo } from "react";
import { diffLines, type Change } from "diff";

interface DiffViewProps {
  baseTex: string;
  tailoredTex: string;
}

interface DiffLine {
  key: string;
  kind: "added" | "removed" | "same";
  text: string;
}

// flattens jsdiff's per-hunk Change[] into one row per source line, each tagged with its own
// add/remove/same kind -- lets the view render a leading +/-/space marker per line (never color
// alone) and keeps each row independently keyable for React.
function toLines(changes: Change[]): DiffLine[] {
  const lines: DiffLine[] = [];
  changes.forEach((part, partIndex) => {
    const kind: DiffLine["kind"] = part.added ? "added" : part.removed ? "removed" : "same";
    // diffLines keeps the trailing "\n" on every line, so splitting on "\n" leaves one bogus
    // empty entry at the end of every part except the last -- drop it rather than render a blank row
    const partLines = part.value.split("\n");
    if (partLines[partLines.length - 1] === "") partLines.pop();
    partLines.forEach((text, lineIndex) => {
      lines.push({ key: `${partIndex}-${lineIndex}`, kind, text });
    });
  });
  return lines;
}

const SIGN: Record<DiffLine["kind"], string> = { added: "+", removed: "-", same: " " };

/**
 * Line-level diff of the base resume against the tailored one, unified view (jsdiff diffLines).
 * Added/removed lines are marked with both color AND a leading +/- character so the distinction
 * never depends on color perception alone.
 */
export default function DiffView({ baseTex, tailoredTex }: DiffViewProps) {
  // recomputed only when the two tex strings actually change (regenerate/request-changes), not on
  // every render of the parent review stage (e.g. while typing in the company/role fields)
  const lines = useMemo(() => toLines(diffLines(baseTex, tailoredTex)), [baseTex, tailoredTex]);
  const hasChanges = useMemo(() => lines.some((l) => l.kind !== "same"), [lines]);

  return (
    <section aria-labelledby="diff-heading" className="dv-root">
      <h3 id="diff-heading" className="dv-heading">
        Résumé changes
      </h3>
      <p className="dv-legend">
        Base resume compared to the tailored version. Added lines are marked{" "}
        <span className="dv-legend-added">+</span>, removed lines{" "}
        <span className="dv-legend-removed">-</span>.
      </p>
      {!hasChanges ? (
        <p className="dv-empty">No differences from the base resume yet.</p>
      ) : (
        <pre className="dv-pre" tabIndex={0} aria-label="Résumé diff, line by line">
          {lines.map((line) => (
            <div key={line.key} className={`dv-line dv-line--${line.kind}`}>
              <span className="dv-sign" aria-hidden="true">
                {SIGN[line.kind]}
              </span>
              <span className="dv-text">{line.text.length ? line.text : " "}</span>
            </div>
          ))}
        </pre>
      )}
    </section>
  );
}
