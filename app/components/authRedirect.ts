export function safeNextPath(raw: string | null, origin = "http://localhost:3000"): string {
  if (!raw || raw.includes("\\") || /%5c/i.test(raw)) return "/";

  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return "/";
    if (url.pathname === "/signin" || url.pathname.startsWith("/signin/")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function currentPathWithSearchAndHash(location: Location): string {
  return `${location.pathname}${location.search}${location.hash}`;
}
