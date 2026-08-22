"use client";

import { useState } from "react";

/**
 * Landing-page-only demo of lib/validator.ts's non-whitelisted-keyword check: the deterministic
 * guard that rejects any new capitalized term the model adds unless it was already in the
 * resume or is explicitly on the user's skills whitelist. Fictional candidate/company/bullet --
 * mirrors the real ReportCard/na-fabrication-ack treatment (same rc-* / na-* classes) so a
 * visitor who later signs in recognizes the exact screen this is standing in for.
 *
 * Two real states, both fully rendered and reachable by keyboard: whitelist off (the honest
 * default -- Kubernetes is rejected) and whitelist on (the term is now verifiable, validator
 * clears it). The toggle is a native <button aria-pressed> so it's operable with Enter/Space
 * with no custom keyboard handling needed.
 */
export default function FabricationDemo() {
  const [onWhitelist, setOnWhitelist] = useState(false);

  return (
    <section aria-labelledby="fab-demo-heading" className="ld-demo">
      <h2 id="fab-demo-heading" className="rc-heading">
        Watch the fabrication guard work
      </h2>
      <p className="na-notice">
        Priya is applying to a Backend Engineer role at Anchorline Freight. The tailored draft
        rewrites one bullet from her resume:
      </p>

      <p className="ld-demo-bullet">
        Optimized checkout throughput with{" "}
        <mark className="ld-demo-term">Kafka</mark> and{" "}
        <mark className={`ld-demo-term${onWhitelist ? "" : " ld-demo-term--flagged"}`}>
          Kubernetes
        </mark>
        , cutting p95 latency by 22%.
      </p>

      <ul className="rc-grid" aria-label="Keyword check">
        <li className="rc-cell rc-cell--matched">
          <span className="rc-cell-mark" aria-hidden="true">
            ✓
          </span>
          <span>
            Kafka<span className="visually-hidden"> — already in Priya&apos;s base resume</span>
          </span>
        </li>
        <li className={`rc-cell rc-cell--${onWhitelist ? "matched" : "not-claimable"}`}>
          <span className="rc-cell-mark" aria-hidden="true">
            {onWhitelist ? "✓" : "×"}
          </span>
          <span>
            Kubernetes
            <span className="visually-hidden">
              {onWhitelist
                ? " — added to the whitelist, now verifiable"
                : " — not in the resume or on the whitelist"}
            </span>
          </span>
        </li>
      </ul>

      <div className="na-actions">
        <button
          type="button"
          className="na-btn na-btn--secondary"
          aria-pressed={onWhitelist}
          onClick={() => setOnWhitelist((v) => !v)}
        >
          {onWhitelist ? "Remove Kubernetes from Priya's whitelist" : "Add Kubernetes to Priya's whitelist"}
        </button>
      </div>
      <p className="na-field-hint">
        In the real app this is a line in Settings, not a switch on the review screen.
      </p>

      {onWhitelist ? (
        <p className="rc-all-matched" role="status">
          Validator cleared the draft — Kubernetes is now verifiable, so it can reach the PDF.
        </p>
      ) : (
        <div className="rc-fabrication-warning" role="alert">
          <p className="rc-fabrication-warning-title">Validator rejected this draft</p>
          <p className="rc-fabrication-warning-body">
            &quot;Kubernetes&quot; isn&apos;t in Priya&apos;s resume and isn&apos;t on her
            whitelist yet. The check runs in code, not a prompt, so it blocks the term
            regardless of what the model was asked to do.
          </p>
        </div>
      )}
    </section>
  );
}
