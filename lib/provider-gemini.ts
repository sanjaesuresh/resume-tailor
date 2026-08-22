import { z } from "zod";
import { GEMINI_API_KEY, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MODEL } from "./config";
import type { ClaudeProvider, StructuredRequest } from "./provider";

// same order of magnitude as the CLI provider's ceiling: a full resume rewrite is one long turn,
// and the request still has to be bounded so a wedged call can't hang an API route forever
const GEMINI_TIMEOUT_MS = 300000;

// enough of a failure to diagnose, not so much that a route's JSON error becomes a wall of text
const ERROR_DETAIL_MAX_CHARS = 800;

/** Anything that went wrong reaching or running Gemini, as opposed to the model answering badly. */
export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiError";
  }
}

// the exact shape this module calls on the SDK -- narrow and duck-typed so tests inject a plain
// object instead of constructing (or type-fighting with) the real GoogleGenAI client
export interface GeminiGenerateParams {
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    responseMimeType: string;
    responseJsonSchema: unknown;
    maxOutputTokens: number;
    abortSignal?: AbortSignal;
  };
}

export interface GeminiResponse {
  text?: string;
  candidates?: { finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export interface GeminiClient {
  models: {
    generateContent(params: GeminiGenerateParams): Promise<GeminiResponse>;
  };
}

// Google returns 503 "high demand" often enough on the flash models that a single spike would
// otherwise kill a whole tailoring run: tailor.ts's retry loop only re-prompts on a bad *answer*,
// so a transport throw escapes it entirely and surfaces as a 502. Retried here instead, which is
// where transport concerns belong and leaves that loop's semantics untouched.
const TRANSIENT_STATUS = [429, 500, 502, 503, 504];
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

export interface GeminiProviderOptions {
  client?: GeminiClient; // inject a fake in tests; the real client is built lazily otherwise
  model?: string;
  timeoutMs?: number;
  retries?: number;
  sleepFn?: (ms: number) => Promise<void>; // injected in tests so backoff costs no wall time
}

/**
 * Builds the Gemini-backed provider. Structured output goes through `responseJsonSchema` with a
 * JSON mime type, which makes the model return a bare JSON document; this module parses it and
 * holds it to the caller's Zod schema, so the contract matches the other two providers exactly --
 * null for "answered, but not in the required shape", a throw for everything else.
 */
export function createGeminiProvider(opts: GeminiProviderOptions = {}): ClaudeProvider {
  const model = opts.model ?? GEMINI_MODEL;
  const timeoutMs = opts.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const retries = opts.retries ?? MAX_TRANSIENT_RETRIES;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let client = opts.client;

  const provider: ClaudeProvider = async <S extends z.ZodType>(req: StructuredRequest<S>) => {
    client ??= await defaultClient();
    const resolved = client;

    const callOnce = async (): Promise<GeminiResponse> => {
      // the SDK's abortSignal only gives up client-side (the request is still billed), but it is
      // what stops a hung call from holding an API route open indefinitely. Fresh per attempt so a
      // retry is not born already-aborted.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await resolved.models.generateContent({
          model,
          contents: req.user,
          config: {
            systemInstruction: req.system,
            responseMimeType: "application/json",
            responseJsonSchema: toGeminiJsonSchema(req.schema),
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            abortSignal: controller.signal,
          },
        });
      } catch (err) {
        throw describeCallFailure(err, controller.signal.aborted, timeoutMs, model);
      } finally {
        clearTimeout(timer);
      }
    };

    const callWithRetry = async (): Promise<GeminiResponse> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callOnce();
        } catch (err) {
          // a timeout is not retried: the caller has already waited the full budget once, and
          // spending it again is worse than failing fast with a message that says what happened
          if (attempt >= retries || !isTransientFailure(err)) throw err;
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        }
      }
    };

    const text = extractText(await callWithRetry());
    // a bare string that isn't JSON is the model ignoring its own output format -- that is a model
    // mistake the tailoring retry loop knows how to nudge, so it is a null, not a throw
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }

    const parsed = req.schema.safeParse(payload);
    return parsed.success ? (parsed.data as z.infer<S>) : null;
  };

  return provider;
}

/**
 * Zod's JSON Schema output carries a draft-2020-12 `$schema` ref that Gemini's supported-keyword
 * list does not include. Dropped here for the same reason provider-cli.ts drops it: the ref adds
 * nothing to a flat object of string fields, and leaving it in risks the whole schema being
 * rejected. Exported so the shape sent to Google is pinned by a test rather than only by a live run.
 */
export function toGeminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

/**
 * Pulls the JSON document out of the response, turning the ways Gemini can return no usable text
 * into named errors. Each of these is unfixable by the retry loop -- feeding validator violations
 * back to a model that hit its token ceiling just burns two more calls on the same wall -- so they
 * throw rather than returning null.
 */
export function extractText(response: GeminiResponse): string {
  const text = response.text?.trim();
  if (text) return text;

  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new GeminiError(
      `Gemini blocked the request before generating (${blockReason}). This usually means the job ` +
        `posting or resume tripped a safety filter.`
    );
  }

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    throw new GeminiError(
      `Gemini hit its output token limit (${GEMINI_MAX_OUTPUT_TOKENS}) before finishing the ` +
        `document. Raise GEMINI_MAX_OUTPUT_TOKENS in .env.local.`
    );
  }
  if (finishReason && finishReason !== "STOP") {
    throw new GeminiError(`Gemini stopped early (${finishReason}) and returned no usable output`);
  }

  throw new GeminiError("Gemini returned an empty response");
}

/**
 * Whether a failure is worth another attempt. Google reports both a temporary overload and a hard
 * free-tier quota as 429/503, and they are not distinguishable from the message, so a hard quota
 * costs a few seconds of pointless backoff before failing -- the right trade against losing a
 * two-minute tailoring run to a spike. A timeout is deliberately excluded: that budget was already
 * spent once. Exported so the retryable set is pinned by a test.
 */
export function isTransientFailure(err: unknown): boolean {
  if (!(err instanceof GeminiError)) return false;
  if (/timed out after/.test(err.message)) return false;
  return TRANSIENT_STATUS.some((status) => new RegExp(`\\b${status}\\b`).test(err.message));
}

// pure so every branch is unit-testable without a network call. A bad key and an unknown model id
// are the two failures that actually happen when swapping vendors, so both name their own fix.
export function describeCallFailure(
  err: unknown,
  aborted: boolean,
  timeoutMs: number,
  model: string
): GeminiError {
  if (aborted) {
    return new GeminiError(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  const message = err instanceof Error ? err.message : String(err);
  const detail = message.slice(0, ERROR_DETAIL_MAX_CHARS);

  if (/api[ _-]?key|unauthenticated|permission denied|401|403/i.test(detail)) {
    return new GeminiError(
      `Gemini rejected the credentials: ${detail}. Check GEMINI_API_KEY in .env.local, or set ` +
        `LLM_PROVIDER=cli to fall back to the Claude Code CLI.`
    );
  }
  if (/not found|404|is not supported|unknown name/i.test(detail)) {
    return new GeminiError(
      `Gemini does not recognize the model "${model}": ${detail}. Set GEMINI_MODEL in .env.local ` +
        `to a current model id.`
    );
  }
  return new GeminiError(`Gemini request failed: ${detail}`);
}

// imported lazily so nothing loads the SDK (or requires a key) until a call is actually made --
// the same reason the Anthropic client is constructed on first use rather than at module load
async function defaultClient(): Promise<GeminiClient> {
  if (!GEMINI_API_KEY) {
    throw new GeminiError(
      "GEMINI_API_KEY is not set. Add it to .env.local, or set LLM_PROVIDER=cli to use the " +
        "Claude Code CLI instead."
    );
  }
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY }) as unknown as GeminiClient;
}
