"use client";

import { useEffect, useState } from "react";

interface PdfPreviewProps {
  tex: string;
}

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string; log?: string };

/**
 * Compiles the current draft via /api/preview and renders it in the browser's own PDF viewer.
 *
 * Mounted even while its tab is hidden, so the compile runs as a prefetch the moment the review
 * step appears: the tab is usually instant, and a document that cannot build says so before the
 * user reaches Approve.
 *
 * The caller keys this component on `tex`, so a new draft remounts it and state resets to
 * "loading" on its own -- no synchronous setState inside the effect to reset a stale PDF.
 */
export default function PdfPreview({ tex }: PdfPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    // per-run flag, NOT a component-lifetime ref: a ref survives React's StrictMode remount and
    // every Fast Refresh, which is exactly how the fetch handlers in new/page.tsx once latched
    // themselves off permanently
    let cancelled = false;
    let objectUrl: string | undefined;

    (async () => {
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tex }),
        });

        if (res.ok) {
          const blob = await res.blob();
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setState({ status: "ready", url: objectUrl });
          return;
        }

        const data = await res.json().catch(() => null);
        if (cancelled) return;
        setState({
          status: "error",
          message:
            typeof data?.error === "string" ? data.error : "Could not compile a preview.",
          log: typeof data?.log === "string" ? data.log : undefined,
        });
      } catch {
        if (cancelled) return;
        setState({ status: "error", message: "Network error while compiling the preview." });
      }
    })();

    return () => {
      cancelled = true;
      // each effect run owns exactly one object URL; releasing it here is what keeps a long
      // review session from leaking a PDF per regenerate
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [tex]);

  if (state.status === "loading") {
    return (
      <p className="pp-status" role="status">
        Compiling a preview…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="na-error" role="alert">
        <p>{state.message}</p>
        {state.log && <pre className="na-compile-log">{state.log}</pre>}
      </div>
    );
  }

  return (
    <iframe
      className="pp-frame"
      src={state.url}
      title="PDF preview of the tailored résumé"
    />
  );
}
