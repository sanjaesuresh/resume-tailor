import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createGeminiProvider,
  describeCallFailure,
  extractText,
  isTransientFailure,
  toGeminiJsonSchema,
  GeminiError,
  type GeminiClient,
  type GeminiGenerateParams,
  type GeminiResponse,
} from "../provider-gemini";

// backoff is injected everywhere below so no test spends real wall time sleeping
const noSleep = () => Promise.resolve();

const schema = z.object({ tex: z.string() });

// a fake SDK client, so nothing in this suite touches the network or needs an API key
function fakeClient(response: GeminiResponse): {
  client: GeminiClient;
  generateContent: ReturnType<typeof vi.fn>;
} {
  const generateContent = vi.fn().mockResolvedValue(response);
  return { client: { models: { generateContent } }, generateContent };
}

function jsonResponse(payload: unknown): GeminiResponse {
  return { text: JSON.stringify(payload), candidates: [{ finishReason: "STOP" }] };
}

describe("createGeminiProvider", () => {
  it("sends the system prompt as systemInstruction and the user message as contents", async () => {
    const { client, generateContent } = fakeClient(jsonResponse({ tex: "\\documentclass{article}" }));

    const result = await createGeminiProvider({ client })({ system: "sys", user: "usr", schema });

    expect(result).toEqual({ tex: "\\documentclass{article}" });

    const params = generateContent.mock.calls[0][0] as GeminiGenerateParams;
    expect(params.contents).toBe("usr");
    expect(params.config.systemInstruction).toBe("sys");
    expect(params.config.responseMimeType).toBe("application/json");
    expect(params.config.maxOutputTokens).toBeGreaterThan(0);
  });

  it("asks for structured output via responseJsonSchema, without the $schema ref", async () => {
    const { client, generateContent } = fakeClient(jsonResponse({ tex: "x" }));

    await createGeminiProvider({ client })({ system: "s", user: "u", schema });

    const params = generateContent.mock.calls[0][0] as GeminiGenerateParams;
    const sent = params.config.responseJsonSchema as Record<string, unknown>;
    expect(sent.$schema).toBeUndefined();
    expect(sent.type).toBe("object");
    expect(Object.keys(sent.properties as object)).toContain("tex");
  });

  it("uses the configured model, overridable per instance", async () => {
    const { client, generateContent } = fakeClient(jsonResponse({ tex: "x" }));

    await createGeminiProvider({ client, model: "gemini-test-model" })({
      system: "s",
      user: "u",
      schema,
    });

    expect((generateContent.mock.calls[0][0] as GeminiGenerateParams).model).toBe(
      "gemini-test-model"
    );
  });

  it("returns null when the reply is not JSON at all", async () => {
    const { client } = fakeClient({ text: "Sure! Here is your resume:", candidates: [] });
    expect(await createGeminiProvider({ client })({ system: "s", user: "u", schema })).toBeNull();
  });

  it("returns null (rather than a wrong-shaped object) when the JSON does not match the schema", async () => {
    const { client } = fakeClient(jsonResponse({ notTex: 1 }));
    expect(await createGeminiProvider({ client })({ system: "s", user: "u", schema })).toBeNull();
  });

  it("propagates a transport failure as a GeminiError rather than a null", async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const client: GeminiClient = { models: { generateContent } };

    await expect(
      createGeminiProvider({ client })({ system: "s", user: "u", schema })
    ).rejects.toThrow(GeminiError);
  });

  it("times out instead of hanging a route forever", async () => {
    // never resolves on its own -- only the provider's abort timer can end this call
    const generateContent = vi.fn(
      (params: GeminiGenerateParams) =>
        new Promise<GeminiResponse>((_resolve, reject) => {
          params.config.abortSignal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted"))
          );
        })
    );
    const client = { models: { generateContent } } as unknown as GeminiClient;

    await expect(
      createGeminiProvider({ client, timeoutMs: 10 })({ system: "s", user: "u", schema })
    ).rejects.toThrow(/timed out after/);
  });
});

describe("transient overload handling", () => {
  // this is the failure that actually showed up on the first live run: Google answers 503 "high
  // demand" on the flash models often enough that a spike would otherwise lose a whole tailoring
  // run, because tailor.ts only re-prompts on a bad answer and a throw escapes that loop
  function flakyClient(failures: number, status = 503) {
    let calls = 0;
    const generateContent = vi.fn(async () => {
      calls++;
      if (calls <= failures) throw new Error(`{"error":{"code":${status},"status":"UNAVAILABLE"}}`);
      return jsonResponse({ tex: "recovered" });
    });
    return { client: { models: { generateContent } } as GeminiClient, generateContent };
  }

  it("retries a 503 and succeeds on a later attempt", async () => {
    const { client, generateContent } = flakyClient(2);

    const result = await createGeminiProvider({ client, sleepFn: noSleep })({
      system: "s",
      user: "u",
      schema,
    });

    expect(result).toEqual({ tex: "recovered" });
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retry budget rather than looping forever", async () => {
    const { client, generateContent } = flakyClient(99);

    await expect(
      createGeminiProvider({ client, sleepFn: noSleep })({ system: "s", user: "u", schema })
    ).rejects.toThrow(/503/);
    expect(generateContent).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    const { client } = flakyClient(2);

    await createGeminiProvider({
      client,
      sleepFn: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    })({ system: "s", user: "u", schema });

    expect(delays).toEqual([1000, 2000]);
  });

  it("does not retry a failure that will never succeed", async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error("API key not valid"));
    const client = { models: { generateContent } } as unknown as GeminiClient;

    await expect(
      createGeminiProvider({ client, sleepFn: noSleep })({ system: "s", user: "u", schema })
    ).rejects.toThrow(/GEMINI_API_KEY/);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientFailure", () => {
  it("retries the statuses Google uses for overload and rate limiting", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isTransientFailure(new GeminiError(`Gemini request failed: {"code":${status}}`))).toBe(
        true
      );
    }
  });

  it("does not retry an unknown model or a rejected key", () => {
    expect(isTransientFailure(new GeminiError('failed: {"code":404,"status":"NOT_FOUND"}'))).toBe(
      false
    );
    expect(isTransientFailure(new GeminiError('failed: {"code":403}'))).toBe(false);
  });

  it("does not retry a timeout -- that budget was already spent once", () => {
    expect(isTransientFailure(new GeminiError("Gemini request timed out after 300s"))).toBe(false);
  });

  it("ignores a status-like number embedded in a longer one", () => {
    expect(isTransientFailure(new GeminiError("Gemini request failed: took 1500ms"))).toBe(false);
  });
});

describe("toGeminiJsonSchema", () => {
  it("drops the draft ref Gemini's keyword list does not support, keeping the shape", () => {
    const converted = toGeminiJsonSchema(z.object({ company: z.string(), role: z.string() }));

    expect(converted.$schema).toBeUndefined();
    expect(converted.type).toBe("object");
    expect(Object.keys(converted.properties as object)).toEqual(["company", "role"]);
  });
});

describe("extractText", () => {
  it("returns the trimmed document when the model finished normally", () => {
    expect(extractText({ text: '  {"tex":"x"}  ', candidates: [{ finishReason: "STOP" }] })).toBe(
      '{"tex":"x"}'
    );
  });

  it("names the token ceiling rather than looking like a schema mismatch", () => {
    // this is the failure mode worth distinguishing: the retry loop cannot nudge a model past its
    // own output limit, so three attempts would hit the same wall and report a parse failure
    expect(() => extractText({ candidates: [{ finishReason: "MAX_TOKENS" }] })).toThrow(
      /output token limit/
    );
  });

  it("reports a safety block against the prompt", () => {
    expect(() => extractText({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/blocked/);
  });

  it("reports any other early stop", () => {
    expect(() => extractText({ candidates: [{ finishReason: "RECITATION" }] })).toThrow(
      /stopped early \(RECITATION\)/
    );
  });

  it("reports an empty response with no reason given", () => {
    expect(() => extractText({})).toThrow(/empty response/);
  });
});

describe("describeCallFailure", () => {
  it("names the key when the credentials were rejected", () => {
    const err = describeCallFailure(new Error("API key not valid"), false, 1000, "m");
    expect(err.message).toMatch(/GEMINI_API_KEY/);
  });

  it("names the model setting when the model id is unknown", () => {
    const err = describeCallFailure(
      new Error("models/gemini-9 is not found for API version v1"),
      false,
      1000,
      "gemini-9"
    );
    expect(err.message).toMatch(/GEMINI_MODEL/);
    expect(err.message).toMatch(/gemini-9/);
  });

  it("reports a timeout as a timeout, whatever the underlying abort error said", () => {
    const err = describeCallFailure(new Error("The operation was aborted"), true, 300000, "m");
    expect(err.message).toBe("Gemini request timed out after 300s");
  });

  it("falls back to quoting the failure for anything unrecognized", () => {
    expect(describeCallFailure(new Error("socket hang up"), false, 1000, "m").message).toMatch(
      /socket hang up/
    );
  });
});
