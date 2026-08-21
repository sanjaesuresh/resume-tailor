import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL, MAX_TOKENS } from "./config";
import type { ClaudeProvider, StructuredRequest } from "./provider";

// the exact shape this module calls on a Claude client -- narrow and duck-typed so tests can
// inject a fake stub without constructing (or type-fighting with) the real Anthropic SDK client
export interface ClaudeParseParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
  output_config: { format: unknown };
}

export interface ClaudeClient {
  messages: {
    parse(params: ClaudeParseParams): Promise<{ parsed_output: unknown }>;
  };
}

/**
 * The original code path, unchanged: `messages.parse` with a Zod-derived output format.
 *
 * No temperature/top_p/top_k here -- this model rejects them (400). No assistant-message
 * prefill either -- also rejected. Structured output comes from output_config.format alone.
 *
 * Requires ANTHROPIC_API_KEY and credits on the API account; see provider-cli.ts for the
 * subscription-billed alternative.
 */
export function createApiProvider(client?: ClaudeClient): ClaudeProvider {
  // constructed lazily by the caller passing nothing, so tests and CLI-provider runs never
  // need an API key just for this module to load
  let resolved = client;

  const provider: ClaudeProvider = async <S extends z.ZodType>(req: StructuredRequest<S>) => {
    resolved ??= new Anthropic() as unknown as ClaudeClient;

    const response = await resolved.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { format: zodOutputFormat(req.schema) },
    });

    if (response.parsed_output === null || response.parsed_output === undefined) return null;
    // the SDK already validated against the same schema; re-checking here keeps `parsed_output`
    // typed without a cast and makes both providers return null for the same reason
    const parsed = req.schema.safeParse(response.parsed_output);
    return parsed.success ? (parsed.data as z.infer<S>) : null;
  };

  return provider;
}
