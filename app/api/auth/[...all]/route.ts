import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

// getAuth() lazily builds the Better Auth instance and ensures its tables exist before the first
// real request -- there is no separate startup step to remember to run.
const authHandlers = toNextJsHandler(async (request: Request) => {
  const auth = await getAuth();
  return auth.handler(request);
});

async function logFailedAuthResponse(
  request: Request,
  handler: (request: Request) => Promise<Response>
): Promise<Response> {
  const response = await handler(request);
  if (response.ok) return response;

  const details: { message?: string; code?: string } = {};
  try {
    const body = (await response.clone().json()) as unknown;
    if (body && typeof body === "object") {
      if ("message" in body && typeof body.message === "string") details.message = body.message;
      if ("code" in body && typeof body.code === "string") details.code = body.code;
    }
  } catch {
    // Some infrastructure/runtime failures have no JSON body. Status and path below still matter.
  }

  const url = new URL(request.url);
  console.error("[auth] request failed", {
    method: request.method,
    path: url.pathname,
    status: response.status,
    statusText: response.statusText,
    ...details,
  });

  return response;
}

export const GET = authHandlers.GET;

export function POST(request: Request): Promise<Response> {
  return logFailedAuthResponse(request, authHandlers.POST);
}

export function PATCH(request: Request): Promise<Response> {
  return logFailedAuthResponse(request, authHandlers.PATCH);
}

export function PUT(request: Request): Promise<Response> {
  return logFailedAuthResponse(request, authHandlers.PUT);
}

export function DELETE(request: Request): Promise<Response> {
  return logFailedAuthResponse(request, authHandlers.DELETE);
}
