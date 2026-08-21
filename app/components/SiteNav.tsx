"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/new", label: "New Application" },
  { href: "/", label: "Tracker" },
];

/**
 * Primary site nav. A client leaf (not the whole layout) so the current route can mark itself
 * with aria-current="page" -- the previous version had no way to tell which page you were on
 * beyond the URL bar, since app/layout.tsx is a server component and never saw the route.
 */
export default function SiteNav() {
  const pathname = usePathname();

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
      </nav>
    </header>
  );
}
