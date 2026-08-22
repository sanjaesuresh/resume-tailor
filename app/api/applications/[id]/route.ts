import {
  deleteApplication,
  getApplication,
  toPublicApplication,
  updateApplication,
  type UpdateApplicationPatch,
} from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { removeApplicationFiles } from "@/lib/persist";
import { logger } from "@/lib/log";

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) ? id : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id === null) {
    return Response.json({ error: "Invalid application id" }, { status: 400 });
  }

  // ids are sequential integers, so this endpoint is trivially enumerable. getApplication returns
  // null for "belongs to someone else" exactly as it does for "does not exist", and the 404 below
  // keeps those two indistinguishable -- otherwise the response itself confirms which ids are real.
  const application = getApplication(id, auth.user.id);
  if (!application) {
    return Response.json({ error: `Application ${id} not found` }, { status: 404 });
  }

  return Response.json({ application: toPublicApplication(application) });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id === null) {
    return Response.json({ error: "Invalid application id" }, { status: 400 });
  }

  const existing = getApplication(id, auth.user.id);
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
    const application = updateApplication(id, auth.user.id, patch);
    return Response.json({ application: toPublicApplication(application) });
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

/**
 * Removes an application and the resume files it produced. Irreversible: nothing here is
 * soft-deleted, and the tex/pdf/report are gone from disk, so the UI confirms before calling it.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id === null) {
    return Response.json({ error: "Invalid application id" }, { status: 400 });
  }

  // the ownership scope lives in deleteApplication's WHERE clause, so another user's id simply
  // does not match and comes back as a 404 -- the same answer a genuinely missing row gets
  const deleted = deleteApplication(id, auth.user.id);
  if (!deleted) {
    return Response.json({ error: `Application ${id} not found` }, { status: 404 });
  }

  const log = logger("applications");
  // best-effort, and deliberately after the row is already gone: if this throws, the user still
  // sees the deletion they asked for and what is left behind is an orphaned directory nothing
  // points at, rather than a visible row whose downloads 404
  try {
    const removed = removeApplicationFiles(auth.user.id, deleted.texPath ?? deleted.pdfPath);
    log(`deleted #${id} · files ${removed ? "removed" : "not found on disk"}`);
  } catch (err) {
    log(`deleted #${id} · could not remove files: ${err instanceof Error ? err.message : err}`);
  }

  return Response.json({ deleted: toPublicApplication(deleted) });
}
