import { z } from "zod";
import { PROVIDER, type ProviderName } from "./config";
import { createApiProvider } from "./provider-api";
import { createCliProvider } from "./provider-cli";

/**
 * The seam between this app and Claude: one structured-output call, described as a system
 * prompt, a user message, and the Zod schema the reply must satisfy. Two back ends implement
 * it -- the Anthropic API (metered credits) and the Claude Code CLI (Pro subscription) -- so
 * nothing above this line knows or cares which account is being billed.
 */
export interface StructuredRequest<S extends z.ZodType> {
  system: string;
  user: string;
  schema: S;
}

// Resolves to null when Claude answered but the answer did not match `schema` -- that is a model
// mistake the tailoring retry loop already knows how to nudge, so it is a value, not a throw.
// Everything else (transport, auth, a missing/broken CLI, a timeout) throws, exactly as the
// Anthropic SDK does today, and surfaces through the routes' existing error handling.
export type ClaudeProvider = <S extends z.ZodType>(
  req: StructuredRequest<S>
) => Promise<z.infer<S> | null>;

/**
 * Builds the provider selected by config (env var `CLAUDE_PROVIDER`, default "cli").
 * Called lazily at the point of use so a run that never reaches Claude never constructs a
 * client or requires an API key / a logged-in CLI.
 */
export function getProvider(): ClaudeProvider {
  return PROVIDER === "api" ? createApiProvider() : createCliProvider();
}

// callers (routes, reports) can say which back end answered
export function activeProviderName(): ProviderName {
  return PROVIDER;
}
