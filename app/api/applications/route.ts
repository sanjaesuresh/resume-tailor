import { listApplications, toPublicApplication } from "@/lib/db";
import { requireUser } from "@/lib/auth";

// thin wrapper over listApplications -- newest-first ordering already comes from the db layer.
// Scoped to the session user, and projected before it leaves the process: the stored row carries
// absolute filesystem paths, which would disclose the server's directory layout (and, now that
// artifacts are namespaced, the owner's user id) to anyone who opened the network tab.
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const applications = listApplications(auth.user.id).map(toPublicApplication);
  return Response.json({ applications });
}
