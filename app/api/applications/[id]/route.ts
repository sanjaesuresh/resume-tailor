import { getApplication, updateApplication, type UpdateApplicationPatch } from "@/lib/db";

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) ? id : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id === null) {
    return Response.json({ error: "Invalid application id" }, { status: 400 });
  }

  const application = getApplication(id);
  if (!application) {
    return Response.json({ error: `Application ${id} not found` }, { status: 404 });
  }

  return Response.json({ application });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id === null) {
    return Response.json({ error: "Invalid application id" }, { status: 400 });
  }

  const existing = getApplication(id);
  if (!existing) {
    return Response.json({ error: `Application ${id} not found` }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  // only status/notes are ever settable from this route; company/role edits (also allowed by
  // db.ts's column allow-list) aren't part of this endpoint's contract
  const patch: UpdateApplicationPatch = {};
  // a present-but-non-string value (e.g. {status: 123}) must 400, not silently no-op and return
  // 200 with the row unchanged -- that would read as a successful update that never happened
  if (body.status !== undefined) {
    if (typeof body.status !== "string") {
      return Response.json({ error: "status must be a string" }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string") {
      return Response.json({ error: "notes must be a string" }, { status: 400 });
    }
    patch.notes = body.notes;
  }

  try {
    const application = updateApplication(id, patch);
    return Response.json({ application });
  } catch (err) {
    // updateApplication throws a readable message on an invalid status or an unknown patch
    // key (its column allow-list) -- both are client mistakes, so surface as 400 rather than
    // letting the throw become an unhandled 500
    const message = err instanceof Error ? err.message : "Failed to update application";
    return Response.json({ error: message }, { status: 400 });
  }
}
