import { listApplications } from "@/lib/db";

// thin wrapper over listApplications -- newest-first ordering already comes from the db layer
export async function GET() {
  return Response.json({ applications: listApplications() });
}
