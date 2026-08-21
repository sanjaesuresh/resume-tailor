import fs from "fs";
import { z } from "zod";
import { compileWithAutoFix, type FixFn } from "@/lib/compile";
import { persistApplication, isValidReport, type PersistApplicationInput } from "@/lib/persist";
import {
  BASE_RESUME_PATH,
  WHITELIST_PATH,
  usingSampleResume,
  usingSampleWhitelist,
} from "@/lib/config";
import { formatCount, logger, startTimer, withHeartbeat } from "@/lib/log";
import { getProvider, type ClaudeProvider } from "@/lib/provider";
import { validateTailored, type Violation } from "@/lib/validator";

// structured-output contract for the compile auto-fixer -- deliberately just `{ tex }`, distinct
// from tailor.ts's TailoredResumeSchema (which also carries company/role): this call only ever
// needs a corrected document back.
const FixTexSchema = z.object({ tex: z.string() });

// builds the FixFn compileWithAutoFix expects, backed by whatever provider is passed in -- kept
// as its own factory (rather than inline in POST) so it's injectable in tests without ever
// touching the network or spawning the CLI
export function createFixFn(provider: ClaudeProvider): FixFn {
  return async (tex: string, log: string): Promise<string> => {
    const parsed = await provider({
      system: "You are an expert LaTeX debugger.",
      user: `The following LaTeX document failed to compile with tectonic. Return the corrected document only, changing as little as possible.\n\nCompile log:\n${log}\n\nLaTeX document:\n${tex}`,
      schema: FixTexSchema,
    });

    if (!parsed) {
      throw new Error("Claude did not return a parseable fix");
    }
    return parsed.tex;
  };
}

// mirrors lib/tailor.ts's parseWhitelist (that module isn't exported from and is out of scope for
// this task) -- same markdown convention: a "# ..." header and a short prose blurb are dropped,
// leaving one skill per line
const WHITELIST_COMMENT_MAX_WORDS = 6;
function parseWhitelist(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0) // blank lines
    .filter((line) => !line.startsWith("#")) // markdown header
    .filter((line) => line.split(/\s+/).length <= WHITELIST_COMMENT_MAX_WORDS); // intro prose
}

export interface ApprovePayload {
  tex: string;
  company: string;
  role: string;
  url?: string;
  report: Record<string, unknown>;
}

export interface ApproveDeps {
  provider?: ClaudeProvider; // inject a fake in tests; the configured provider is built lazily otherwise
  baseTex?: string; // override the on-disk base resume (tests)
  whitelist?: string[]; // override the on-disk whitelist (tests)
  dataDir?: string; // forwarded to persistApplication (tests only) so nothing writes into real data/
  now?: Date; // forwarded to persistApplication (tests only)
}

export type ApproveResponse =
  | {
      status: 200;
      body: {
        application: ReturnType<typeof persistApplication>;
        pdfUrl: string;
        usingSampleResume: boolean;
        usingSampleWhitelist: boolean;
      };
    }
  | {
      status: 422;
      body: { error: string; log?: string; violations?: Violation[]; tex?: string };
    };

/**
 * Core approve flow: compiles the approved tex (auto-fixing once via Claude on failure), and --
 * critically -- re-runs the same no-fabrication/no-shrink checks the review gate already ran
 * against the approved draft if the auto-fixer's output is what actually compiled. "Change as
 * little as possible" in the fixer's prompt is an instruction, not a guarantee: without this
 * re-check, an arbitrary Claude rewrite could be compiled, persisted, and downloaded while the
 * tracker's report still describes the tex the user actually reviewed. Only NEW violations (not
 * already present against the approved draft) block persistence, since the review gate may have
 * let a pre-existing issue through and a fix that doesn't make that specific issue worse should
 * still be allowed to save.
 *
 * Factored out of POST so it's directly testable with an injected fake Claude client and a temp
 * dataDir/baseTex/whitelist -- no network, no writes into real data/. Persistence failures
 * (persistApplication throwing) are left to propagate to the caller, distinct from the 422s this
 * function returns for compile/validation problems.
 */
export async function approve(payload: ApprovePayload, deps: ApproveDeps = {}): Promise<ApproveResponse> {
  const { tex, company, role, url, report } = payload;
  const log = logger("approve");
  const elapsed = startTimer();
  log(`compiling ${formatCount(tex.length)} chars with tectonic…`);

  let fixedTex = tex;
  // compileWithAutoFix only returns ok/log, not the tex that produced it -- capture the fixer's
  // output via closure so, on success, we can re-validate (and, if clean, persist) the tex that
  // actually compiled
  // param renamed off `log` so it doesn't shadow the progress logger above
  const { result, usedFix } = await compileWithAutoFix(tex, async (currentTex, compileLog) => {
    // built lazily -- only reached if the first compile attempt actually failed, so a resume that
    // compiles cleanly on the first try never needs an API key or a logged-in CLI
    log(`✗ compile failed · asking claude for a fix…`);
    const fix = createFixFn(deps.provider ?? getProvider());
    fixedTex = await withHeartbeat(log, () => fix(currentTex, compileLog));
    log(`fix returned ${formatCount(fixedTex.length)} chars · recompiling…`);
    return fixedTex;
  });

  if (!result.ok) {
    log(`✗ compilation failed · ${elapsed()}`);
    return { status: 422, body: { error: "Compilation failed", log: result.log } };
  }

  log(`✓ compiled · ${formatCount(result.pdf.length)} bytes · ${elapsed()}${usedFix ? " (auto-fixed)" : ""}`);

  let finalReport: Record<string, unknown> = report;

  if (usedFix) {
    const baseTex = deps.baseTex ?? fs.readFileSync(BASE_RESUME_PATH, "utf-8");
    const whitelist = deps.whitelist ?? parseWhitelist(fs.readFileSync(WHITELIST_PATH, "utf-8"));

    // compare against the APPROVED draft's own violations (not an empty baseline): re-flagging an
    // issue the user already approved past would block an otherwise-good fix for no reason
    const approvedViolations = validateTailored(baseTex, tex, whitelist);
    const fixedViolations = validateTailored(baseTex, fixedTex, whitelist);
    const isNewViolation = (v: Violation) =>
      !approvedViolations.some((a) => a.rule === v.rule && a.message === v.message);
    const newViolations = fixedViolations.filter(isNewViolation);

    log(
      newViolations.length > 0
        ? `✗ auto-fix introduced ${newViolations.length} new violation(s) · not saved`
        : `auto-fix re-validated clean against the approved draft`
    );

    if (newViolations.length > 0) {
      // never persist or hand back a download for a fixer output that fabricated or shrank
      // something the approved draft didn't -- send the user back through the review gate with
      // the fixed tex so they can see exactly what changed and re-approve or reject it
      return {
        status: 422,
        body: {
          error:
            "The auto-fixed resume introduced changes that violate the no-fabrication/no-shrink rules and was not saved",
          violations: newViolations,
          tex: fixedTex,
        },
      };
    }

    // clean: mark the persisted report as auto-fixed so the tracker can distinguish "Claude's
    // fixer touched this" from a first-try clean compile. Note scoreAfter/matchedAfter still
    // describe the approved draft, not the (validated-equivalent) fixed tex -- this route has no
    // job description to recompute the ATS report against the fixed tex.
    finalReport = { ...report, autoFixed: true };
  }

  const persistInput: PersistApplicationInput = {
    tex: usedFix ? fixedTex : tex,
    pdf: result.pdf,
    company,
    role,
    url,
    report: finalReport,
    dataDir: deps.dataDir,
    now: deps.now,
  };
  const application = persistApplication(persistInput);
  log(`✓ saved #${application.id} · ${application.company} / ${application.role} · ${elapsed()} total`);

  return {
    status: 200,
    body: {
      application,
      pdfUrl: `/api/files/${application.id}/pdf`,
      usingSampleResume: usingSampleResume(),
      usingSampleWhitelist: usingSampleWhitelist(),
    },
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const tex = body?.tex;
    const company = body?.company;
    const role = body?.role;
    const url = typeof body?.url === "string" ? body.url : undefined;
    const report = body?.report;

    if (typeof tex !== "string" || tex.trim().length === 0) {
      return Response.json({ error: "Missing tex" }, { status: 422 });
    }
    if (typeof company !== "string" || company.trim().length === 0) {
      return Response.json({ error: "Missing company" }, { status: 422 });
    }
    if (typeof role !== "string" || role.trim().length === 0) {
      return Response.json({ error: "Missing role" }, { status: 422 });
    }
    // without this, an omitted/malformed report would fall through to persistApplication and
    // crash JSON.stringify/writeFileSync partway through, after resume.tex/pdf were already written
    if (!isValidReport(report)) {
      return Response.json({ error: "Missing or invalid report" }, { status: 422 });
    }

    const { status, body: responseBody } = await approve({ tex, company, role, url, report });
    return Response.json(responseBody, { status });
  } catch (err) {
    // any throw past this point (persistApplication hitting a disk-full/locked-db/unwritable path,
    // or any other unexpected failure) is an infra problem, not the "Compilation failed" 422 the
    // UI already knows how to render -- keep it distinguishable so the UI doesn't mislabel a
    // persistence failure as a compile failure
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { error: "Failed to save the approved application", detail: message },
      { status: 500 }
    );
  }
}
