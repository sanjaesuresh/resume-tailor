import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolveProviderName } from "../config";
import { createApiProvider, type ClaudeClient, type ClaudeParseParams } from "../provider-api";

const schema = z.object({ tex: z.string() });

describe("resolveProviderName", () => {
  it("defaults to the CLI (the subscription-billed path) when unset or empty", () => {
    expect(resolveProviderName(undefined)).toBe("cli");
    expect(resolveProviderName("")).toBe("cli");
    expect(resolveProviderName("   ")).toBe("cli");
  });

  it("accepts either provider, case- and whitespace-insensitively", () => {
    expect(resolveProviderName("api")).toBe("api");
    expect(resolveProviderName(" API ")).toBe("api");
    expect(resolveProviderName("CLI")).toBe("cli");
  });

  it("throws on an unrecognized value rather than silently billing the other account", () => {
    expect(() => resolveProviderName("anthropic")).toThrow(/Invalid CLAUDE_PROVIDER/);
    expect(() => resolveProviderName("clii")).toThrow(/Invalid CLAUDE_PROVIDER/);
  });
});

describe("provider selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // config reads CLAUDE_PROVIDER once at module load, so selection can only be exercised by
  // re-importing the module graph with the env var stubbed
  async function loadProviderModule(value?: string) {
    vi.resetModules();
    if (value === undefined) vi.stubEnv("CLAUDE_PROVIDER", "");
    else vi.stubEnv("CLAUDE_PROVIDER", value);
    return import("../provider");
  }

  it("reports the CLI as active by default", async () => {
    const mod = await loadProviderModule();
    expect(mod.activeProviderName()).toBe("cli");
    expect(typeof mod.getProvider()).toBe("function");
  });

  it("switches to the API provider when CLAUDE_PROVIDER=api", async () => {
    const mod = await loadProviderModule("api");
    expect(mod.activeProviderName()).toBe("api");
    // building it must not require a real key -- the SDK client is constructed on first call
    expect(typeof mod.getProvider()).toBe("function");
  });
});

// builds a fake Anthropic client so these tests never touch the network or need an API key
function fakeClient(parsedOutput: unknown): { client: ClaudeClient; parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn().mockResolvedValue({ parsed_output: parsedOutput });
  return { client: { messages: { parse } }, parse };
}

describe("createApiProvider", () => {
  it("sends model, max_tokens, the system prompt and a single user message with a zod output format", async () => {
    const { client, parse } = fakeClient({ tex: "\\documentclass{article}" });

    const result = await createApiProvider(client)({
      system: "sys",
      user: "usr",
      schema,
    });

    expect(result).toEqual({ tex: "\\documentclass{article}" });

    const params = parse.mock.calls[0][0] as ClaudeParseParams;
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.max_tokens).toBeGreaterThan(0);
    expect(params.system).toBe("sys");
    expect(params.messages).toEqual([{ role: "user", content: "usr" }]);
    expect(params.output_config.format).toBeDefined();
  });

  it("never passes temperature/top_p/top_k and never prefills an assistant message (this model 400s on both)", async () => {
    const { client, parse } = fakeClient({ tex: "x" });

    await createApiProvider(client)({ system: "sys", user: "usr", schema });

    const params = parse.mock.calls[0][0] as Record<string, unknown>;
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    expect(params.top_k).toBeUndefined();
    expect((params.messages as { role: string }[]).every((m) => m.role === "user")).toBe(true);
  });

  it("returns null when the SDK could not parse a structured reply", async () => {
    const { client } = fakeClient(null);
    expect(await createApiProvider(client)({ system: "s", user: "u", schema })).toBeNull();
  });

  it("returns null (rather than a wrong-shaped object) when the reply does not match the schema", async () => {
    const { client } = fakeClient({ notTex: 1 });
    expect(await createApiProvider(client)({ system: "s", user: "u", schema })).toBeNull();
  });
});
