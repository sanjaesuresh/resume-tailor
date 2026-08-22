"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/app/components/authClient";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/new", label: "New Application" },
  { href: "/applications", label: "Tracker" },
  { href: "/settings", label: "Settings" },
];

/**
 * Primary site nav. A client leaf (not the whole layout) so the current route can mark itself
 * with aria-current="page" -- the previous version had no way to tell which page you were on
 * beyond the URL bar, since app/layout.tsx is a server component and never saw the route.
 */
export default function SiteNav() {
  const pathname = usePathname();
  const router = useRouter();
  // shared nanostore, not a fetch this component owns -- signing out elsewhere (or a session
  // expiring) updates this without SiteNav doing any polling of its own
  const { data: session, isPending } = authClient.useSession();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await authClient.signOut();
    setSigningOut(false);
    // every route ends up requiring a session once phase 1 lands ownership checks, so sending the
    // user straight to sign-in avoids a render of a now-unauthorized page before the redirect
    router.push("/signin");
  }

  return (
    <header className="site-nav">
      <nav aria-label="Primary">
        {LINKS.map((link) => {
          const current = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={current ? "page" : undefined}
              className={current ? "site-nav-link site-nav-link--current" : "site-nav-link"}
            >
              {link.label}
            </Link>
          );
        })}

        {/* isPending covers the instant on first paint before the session store resolves --
            rendering nothing then (rather than a placeholder) avoids a flash of the wrong state */}
        {!isPending && (
          <div className="site-nav-account">
            {session?.user ? (
              <>
                <span className="site-nav-user">{session.user.email}</span>
                <button
                  type="button"
                  className="na-link-btn"
                  onClick={handleSignOut}
                  disabled={signingOut}
                >
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </>
            ) : (
              <Link
                href="/signin"
                aria-current={pathname === "/signin" ? "page" : undefined}
                className={
                  pathname === "/signin" ? "site-nav-link site-nav-link--current" : "site-nav-link"
                }
              >
                Sign in
              </Link>
            )}
          </div>
        )}
      </nav>
    </header>
  );
}
