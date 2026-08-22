import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolveProviderName } from "../config";
import { createApiProvider, type ClaudeClient, type ClaudeParseParams } from "../provider-api";

const schema = z.object({ tex: z.string() });

describe("resolveProviderName", () => {
  it("falls back to the CLI when nothing is set and there is no Gemini key", () => {
    expect(resolveProviderName(undefined)).toBe("cli");
    expect(resolveProviderName("")).toBe("cli");
    expect(resolveProviderName("   ")).toBe("cli");
  });

  it("treats a Gemini key as the intent to use Gemini when nothing is set", () => {
    expect(resolveProviderName(undefined, true)).toBe("gemini");
    expect(resolveProviderName("", true)).toBe("gemini");
  });

  it("lets an explicit setting override the key-presence default", () => {
    // otherwise you could never test the CLI path on a machine that has a Gemini key configured
    expect(resolveProviderName("cli", true)).toBe("cli");
    expect(resolveProviderName("api", true)).toBe("api");
  });

  it("accepts any provider, case- and whitespace-insensitively", () => {
    expect(resolveProviderName("api")).toBe("api");
    expect(resolveProviderName(" API ")).toBe("api");
    expect(resolveProviderName("CLI")).toBe("cli");
    expect(resolveProviderName(" Gemini ")).toBe("gemini");
  });

  it("throws on an unrecognized value rather than silently billing another account", () => {
    expect(() => resolveProviderName("anthropic")).toThrow(/Invalid LLM_PROVIDER/);
    expect(() => resolveProviderName("clii")).toThrow(/Invalid LLM_PROVIDER/);
    expect(() => resolveProviderName("google")).toThrow(/Invalid LLM_PROVIDER/);
  });
});

describe("provider selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // config reads the env once at module load, so selection can only be exercised by re-importing
  // the module graph with the vars stubbed
  async function loadProviderModule(value?: string, geminiKey = "") {
    vi.resetModules();
    vi.stubEnv("LLM_PROVIDER", value ?? "");
    vi.stubEnv("CLAUDE_PROVIDER", "");
    vi.stubEnv("GEMINI_API_KEY", geminiKey);
    return import("../provider");
  }

  it("reports the CLI as active when nothing is configured", async () => {
    const mod = await loadProviderModule();
    expect(mod.activeProviderName()).toBe("cli");
    expect(typeof mod.getProvider()).toBe("function");
  });

  it("switches to the API provider when LLM_PROVIDER=api", async () => {
    const mod = await loadProviderModule("api");
    expect(mod.activeProviderName()).toBe("api");
    // building it must not require a real key -- the SDK client is constructed on first call
    expect(typeof mod.getProvider()).toBe("function");
  });

  it("switches to Gemini on the key alone, and builds without touching the network", async () => {
    const mod = await loadProviderModule(undefined, "test-key-not-real");
    expect(mod.activeProviderName()).toBe("gemini");
    expect(typeof mod.getProvider()).toBe("function");
  });

  it("still honours the old CLAUDE_PROVIDER name so an existing .env.local keeps working", async () => {
    vi.resetModules();
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("CLAUDE_PROVIDER", "api");
    const mod = await import("../provider");
    expect(mod.activeProviderName()).toBe("api");
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
