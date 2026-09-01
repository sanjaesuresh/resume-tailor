import { execFile } from "child_process";
import { assertAuthRuntimeConfig } from "@/lib/auth";
import { DATA_DIR } from "@/lib/config";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HealthCheck {
  ok: boolean;
  detail?: string;
}

type HealthChecks = Record<"auth" | "sqlite" | "tectonic", HealthCheck>;

function getOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getPublicRequestOrigin(request: Request): string {
  const headers = request.headers;
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host")?.trim();

  if (host) {
    return `${forwardedProto || new URL(request.url).protocol.replace(":", "")}://${host}`;
  }

  return new URL(request.url).origin;
}

async function check(name: keyof HealthChecks, fn: () => void | Promise<void>): Promise<HealthCheck> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${name}: ${message}` };
  }
}

function checkSqliteWritable(): void {
  const db = getDb();

  db.prepare("SELECT 1").get();

  let savepointOpen = false;
  try {
    db.exec("SAVEPOINT health_check");
    savepointOpen = true;
    db.exec(`
      CREATE TABLE IF NOT EXISTS __health_check_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        checked_at TEXT NOT NULL
      )
    `);
    db.prepare(
      "INSERT OR REPLACE INTO __health_check_probe (id, checked_at) VALUES (1, ?)"
    ).run(new Date().toISOString());
    db.exec("ROLLBACK TO health_check");
    db.exec("RELEASE health_check");
    savepointOpen = false;
  } catch (err) {
    if (savepointOpen) {
      try {
        db.exec("ROLLBACK TO health_check");
      } catch {
        // ignore cleanup failure; report the original write failure below
      }
      try {
        db.exec("RELEASE health_check");
      } catch {
        // ignore cleanup failure; report the original write failure below
      }
    }
    throw err;
  }
}

function checkTectonicAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tectonic", ["--version"], { timeout: 3000 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function GET(request: Request): Promise<Response> {
  let configuredAuthBaseURL: string | null = null;
  const checks: HealthChecks = {
    auth: await check("auth", () => {
      configuredAuthBaseURL = assertAuthRuntimeConfig().baseURL;
    }),
    sqlite: await check("sqlite", checkSqliteWritable),
    tectonic: await check("tectonic", checkTectonicAvailable),
  };

  const ok = Object.values(checks).every((result) => result.ok);
  const requestOrigin = getPublicRequestOrigin(request);
  const configuredAuthOrigin = configuredAuthBaseURL ? getOrigin(configuredAuthBaseURL) : null;

  return Response.json(
    {
      status: ok ? "ok" : "error",
      dataDir: DATA_DIR,
      auth: {
        configuredBaseURL: configuredAuthBaseURL,
        requestOrigin,
        originMatchesRequest: configuredAuthOrigin === requestOrigin,
      },
      checks,
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
