import fs from "fs";
import path from "path";
import { getApplication } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getUserSettings } from "@/lib/settings";
import { DATA_DIR, RESUME_OWNER_NAME } from "@/lib/config";

type FileKind = "pdf" | "tex";

const CONTENT_TYPES: Record<FileKind, string> = {
  pdf: "application/pdf",
  tex: "application/x-tex; charset=utf-8",
};

function isFileKind(value: string): value is FileKind {
  return value === "pdf" || value === "tex";
}

/**
 * The name the file lands under in a recruiter-facing downloads folder: "Resume - <Owner> <id>".
 * The tracker id (not the company-role slug) makes it stable and unambiguous when several
 * tailored versions are downloaded side by side.
 *
 * Exported and pure so the format is pinned by a test -- the route itself needs a real database
 * row and DATA_DIR to exercise.
 */
export function downloadFilename(id: number, kind: FileKind, ownerName?: string | null): string {
  // quotes and control characters would break out of the quoted Content-Disposition value.
  // Re-sanitised here even though settings validation already does it, because this is the last
  // point before the value reaches a header and the env fallback never passed through settings.
  const raw = ownerName?.trim() || RESUME_OWNER_NAME;
  const owner = raw.replace(/["\\\r\n]/g, "").trim();
  // "Resume - " and the id are supplied here, so a display name of "Sanjae Suresh" is what
  // produces "Resume - Sanjae Suresh 12.pdf" -- the name alone, not the whole filename
  return `Resume - ${owner} ${id}.${kind}`;
}

/**
 * Streams a persisted application's pdf or tex from disk. Never builds the filesystem path from
 * the request params directly -- it looks up the stored path via the db row, then resolves and
 * verifies that path stays within DATA_DIR before reading, so neither a crafted `id`/`kind` nor a
 * corrupted row can be used to read files outside the data directory.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> }
) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;

  const { id: idParam, kind: kindParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return Response.json({ error: "Invalid application id" }, { status: 400 });
  }
  if (!isFileKind(kindParam)) {
    return Response.json({ error: "Invalid file kind; must be pdf or tex" }, { status: 400 });
  }
  const kind = kindParam;

  // the ownership scope here is the ONLY thing preventing cross-tenant download: ids are
  // sequential integers, so without it `for i in $(seq 1 500)` walks every user's resumes. The
  // path containment check below is a traversal guard, not an authorization check -- it answers
  // "is this inside data/", which stays true for everyone once directories are per-user.
  const application = getApplication(id, auth.user.id);
  if (!application) {
    return Response.json({ error: `Application ${id} not found` }, { status: 404 });
  }

  const storedPath = kind === "pdf" ? application.pdfPath : application.texPath;
  if (!storedPath) {
    return Response.json({ error: `No ${kind} stored for this application` }, { status: 404 });
  }

  // Containment is scoped to THIS user's directory, not to DATA_DIR: checking against DATA_DIR
  // was fine when one person owned everything, but it is satisfied by every user's directory once
  // artifacts are namespaced, so it would no longer catch a row whose stored path points into
  // someone else's. Defence in depth behind the ownership check above -- it is what would still
  // hold if a row were ever mis-assigned, restored from a stale backup, or hand-edited.
  const resolvedUserDir = path.resolve(path.join(DATA_DIR, "applications", auth.user.id));
  const resolvedPath = path.resolve(storedPath);
  if (!resolvedPath.startsWith(resolvedUserDir + path.sep)) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  if (!fs.existsSync(resolvedPath)) {
    return Response.json({ error: "File not found on disk" }, { status: 404 });
  }

  const body = fs.readFileSync(resolvedPath);
  // the name a recruiter sees on disk comes from the owner's own settings; RESUME_OWNER_NAME
  // stays as the fallback for an account that has not set one
  const filename = downloadFilename(id, kind, getUserSettings(auth.user.id).displayName);

  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[kind],
      // filename* carries the UTF-8 form for any non-ASCII in the owner's name; the plain
      // filename stays as the fallback for clients that ignore RFC 5987
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
        filename
      )}`,
    },
  });
}
