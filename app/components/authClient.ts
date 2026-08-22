"use client";

// one shared better-auth browser client so the sign-in page, the sign-up page, and the nav's
// session indicator all read the same session store (a nanostore under the hood) instead of each
// opening its own -- signing out in one place is reflected everywhere without a manual refetch.
// No baseURL is passed: better-auth's client falls back to the same-origin "/api/auth", which is
// exactly where app/api/auth/[...all]/route.ts mounts the handler.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
