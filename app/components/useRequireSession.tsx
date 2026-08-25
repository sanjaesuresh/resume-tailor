"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/app/components/authClient";
import { currentPathWithSearchAndHash } from "@/app/components/authRedirect";

export function useRequireSession(): { isAuthenticated: boolean; isPending: boolean } {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const isAuthenticated = !!session?.user;

  useEffect(() => {
    if (!isPending && !isAuthenticated) {
      const next = currentPathWithSearchAndHash(window.location);
      router.replace(`/signin?next=${encodeURIComponent(next)}`);
    }
  }, [isAuthenticated, isPending, pathname, router]);

  return { isAuthenticated, isPending };
}

export function AuthGateLoading({ heading, label }: { heading: string; label: string }) {
  return (
    <main className="tr-root">
      <h1 className="tr-title">{heading}</h1>
      <div className="tr-skeleton" role="status" aria-label={label}>
        <div className="tr-skeleton-row" aria-hidden="true" />
        <div className="tr-skeleton-row" aria-hidden="true" />
        <div className="tr-skeleton-row" aria-hidden="true" />
      </div>
    </main>
  );
}
