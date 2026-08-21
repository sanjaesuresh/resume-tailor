import fs from "fs";
import path from "path";
import { getApplication } from "@/lib/db";
import { DATA_DIR } from "@/lib/config";

type FileKind = "pdf" | "tex";

const CONTENT_TYPES: Record<FileKind, string> = {
  pdf: "application/pdf",
  tex: "application/x-tex; charset=utf-8",
};

function isFileKind(value: string): value is FileKind {
  return value === "pdf" || value === "tex";
}

/**
 * Streams a persisted application's pdf or tex from disk. Never builds the filesystem path from
 * the request params directly -- it looks up the stored path via the db row, then resolves and
 * verifies that path stays within DATA_DIR before reading, so neither a crafted `id`/`kind` nor a
 * corrupted row can be used to read files outside the data directory.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> }
) {
  const { id: idParam, kind: kindParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return Response.json({ error: "Invalid application id" }, { status: 400 });
  }
  if (!isFileKind(kindParam)) {
    return Response.json({ error: "Invalid file kind; must be pdf or tex" }, { status: 400 });
  }
  const kind = kindParam;

  const application = getApplication(id);
  if (!application) {
    return Response.json({ error: `Application ${id} not found` }, { status: 404 });
  }

  const storedPath = kind === "pdf" ? application.pdfPath : application.texPath;
  if (!storedPath) {
    return Response.json({ error: `No ${kind} stored for this application` }, { status: 404 });
  }

  // path-traversal guard: the resolved path must be DATA_DIR itself or a descendant of it
  const resolvedDataDir = path.resolve(DATA_DIR);
  const resolvedPath = path.resolve(storedPath);
  const isInsideDataDir =
    resolvedPath === resolvedDataDir || resolvedPath.startsWith(resolvedDataDir + path.sep);
  if (!isInsideDataDir) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  if (!fs.existsSync(resolvedPath)) {
    return Response.json({ error: "File not found on disk" }, { status: 404 });
  }

  // the slug directory name doubles as a human-readable download filename
  const slug = path.basename(path.dirname(resolvedPath));
  const body = fs.readFileSync(resolvedPath);

  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[kind],
      "Content-Disposition": `attachment; filename="${slug}.${kind}"`,
    },
  });
}
