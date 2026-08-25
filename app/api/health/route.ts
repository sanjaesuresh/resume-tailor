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

export async function GET(): Promise<Response> {
  const checks: HealthChecks = {
    auth: await check("auth", () => {
      assertAuthRuntimeConfig();
    }),
    sqlite: await check("sqlite", checkSqliteWritable),
    tectonic: await check("tectonic", checkTectonicAvailable),
  };

  const ok = Object.values(checks).every((result) => result.ok);
  return Response.json(
    {
      status: ok ? "ok" : "error",
      dataDir: DATA_DIR,
      checks,
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
