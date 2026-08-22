import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

// getAuth() lazily builds the Better Auth instance and ensures its tables exist before the first
// real request -- there is no separate startup step to remember to run.
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(async (request: Request) => {
  const auth = await getAuth();
  return auth.handler(request);
});
