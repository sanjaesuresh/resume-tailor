import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { compileWithAutoFix, type FixFn } from "@/lib/compile";
import { persistApplication, isValidReport } from "@/lib/persist";
import { MODEL, MAX_TOKENS } from "@/lib/config";

// structured-output contract for the compile auto-fixer -- deliberately just `{ tex }`, distinct
// from tailor.ts's TailoredResumeSchema (which also carries company/role): this call only ever
// needs a corrected document back.
const FixTexSchema = z.object({ tex: z.string() });

// same narrow duck-typed client shape as tailor.ts's ClaudeClient, so a fake can be injected
// without constructing (or type-fighting with) the real Anthropic SDK client
export interface FixClaudeClient {
  messages: {
    parse(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
      output_config: { format: ReturnType<typeof zodOutputFormat<typeof FixTexSchema>> };
    }): Promise<{ parsed_output: { tex: string } | null }>;
  };
}

// builds the FixFn compileWithAutoFix expects, backed by whatever Claude client is passed in --
// kept as its own factory (rather than inline in POST) so it's injectable in tests without
// ever touching the network. No temperature/top_p/top_k, no assistant prefill: this model 400s on both.
export function createFixFn(client: FixClaudeClient): FixFn {
  return async (tex: string, log: string): Promise<string> => {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: "You are an expert LaTeX debugger.",
      messages: [
        {
          role: "user",
          content: `The following LaTeX document failed to compile with tectonic. Return the corrected document only, changing as little as possible.\n\nCompile log:\n${log}\n\nLaTeX document:\n${tex}`,
        },
      ],
      output_config: { format: zodOutputFormat(FixTexSchema) },
    });

    if (!response.parsed_output) {
      throw new Error("Claude did not return a parseable fix");
    }
    return response.parsed_output.tex;
  };
}

/**
 * Compiles the approved tex (auto-fixing once via Claude on failure), persists the resulting
 * PDF/tex/report + tracker row on success, and returns the row plus a download URL. A final
 * compile failure (original attempt failed and the fix either didn't help or wasn't applied)
 * is a 422 with the tectonic log so the UI can show the caller what broke, not a 500.
 */
export async function POST(request: Request) {
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

  // constructed lazily (only reached once we know the request is well-formed) so this module
  // never requires an API key just to be imported, matching lib/tailor.ts's pattern
  const client = new Anthropic() as unknown as FixClaudeClient;
  const fix = createFixFn(client);

  // compileWithAutoFix only returns ok/log, not the tex that produced it -- capture the fixer's
  // output via closure so, on success, we persist the tex that actually compiled
  let fixedTex = tex;
  const { result, usedFix } = await compileWithAutoFix(tex, async (currentTex, log) => {
    fixedTex = await fix(currentTex, log);
    return fixedTex;
  });

  if (!result.ok) {
    return Response.json({ error: "Compilation failed", log: result.log }, { status: 422 });
  }

  const application = persistApplication({
    tex: usedFix ? fixedTex : tex,
    pdf: result.pdf,
    company,
    role,
    url,
    report,
  });

  return Response.json({
    application,
    pdfUrl: `/api/files/${application.id}/pdf`,
  });
}
