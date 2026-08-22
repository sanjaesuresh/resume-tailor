"use client";

import Link from "next/link";
import { authClient } from "@/app/components/authClient";
import FabricationDemo from "@/app/components/FabricationDemo";

/**
 * Public landing page. No requireUser, no protected fetch -- a signed-out visitor is the normal
 * case here, not an error state, so the only session-aware thing on the page is which call to
 * action shows (sign in vs. go to the tracker you already have).
 */
export default function LandingPage() {
  const { data: session, isPending } = authClient.useSession();

  return (
    <main className="na-root">
      <section className="na-section">
        <h1 className="na-heading">Resume Tailor</h1>
        <p className="na-notice">
          Paste a job posting. Get your resume rewritten to match it, checked line by line before
          you ever hit approve.
        </p>

        {/* isPending covers the instant before the session store resolves -- same "don't flash
            the wrong state" guard SiteNav uses for its own account section */}
        {!isPending && (
          <div className="na-actions">
            {session?.user ? (
              <>
                <Link href="/applications" className="na-btn na-btn--primary">
                  Go to your tracker
                </Link>
                <Link href="/new" className="na-btn na-btn--secondary">
                  Start an application
                </Link>
              </>
            ) : (
              <Link href="/signin" className="na-btn na-btn--primary">
                Sign in
              </Link>
            )}
          </div>
        )}
      </section>

      <FabricationDemo />
    </main>
  );
}
