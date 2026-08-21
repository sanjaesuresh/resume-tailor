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
    const message = err instanceof Error ? err.message : "Failed to update application";

    // updateApplication throws exactly these readable messages for client mistakes: an invalid
    // status value, or an unknown patch column (its allow-list). Match them narrowly by prefix --
    // anything else (SQLITE_BUSY, a locked/corrupted db, disk I/O) is an infra problem and must
    // not be mislabeled as a 400 the caller could have avoided.
    if (message.startsWith("Invalid status ") || message.startsWith("Unknown field ")) {
      return Response.json({ error: message }, { status: 400 });
    }
    // the row existed at the GET-then-check above but vanished before the update itself
    if (message.endsWith("not found")) {
      return Response.json({ error: message }, { status: 404 });
    }
    return Response.json({ error: "Failed to update application" }, { status: 500 });
  }
}
