import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ChildProcess, SpawnOptions } from "child_process";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCliProvider, ClaudeCliError, type SpawnFn } from "../provider-cli";

const schema = z.object({ company: z.string(), role: z.string(), tex: z.string() });
const answer = { company: "Acme", role: "Engineer", tex: "\\documentclass{article}" };

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn().mockReturnValue(true);
  return child;
}

// the real CLI is never spawned by this suite: every test drives a fake child process instead.
// `behavior` runs on the next tick, after the provider has attached its stdout/stderr/close
// listeners, so a scripted response can never race the code under test.
function stubSpawn(behavior: (child: FakeChild) => void) {
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const stdin: string[] = [];

  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = makeChild();
    child.stdin.on("data", (chunk) => stdin.push(String(chunk)));
    setImmediate(() => behavior(child));
    return child as unknown as ChildProcess;
  };

  return { spawnFn, calls, stdin };
}

// closes stdout (so the provider's "data" then "end" fire in order) before reporting the exit
function respond(child: FakeChild, opts: { stdout?: string; stderr?: string; code?: number }) {
  child.stderr.end(opts.stderr ?? "");
  child.stdout.end(opts.stdout ?? "");
  child.stdout.on("end", () => child.emit("close", opts.code ?? 0));
}

function successEnvelope(structuredOutput: unknown) {
  return JSON.stringify({
    is_error: false,
    subtype: "success",
    result: JSON.stringify(structuredOutput),
    structured_output: structuredOutput,
  });
}

function callProvider(spawnFn: SpawnFn, user = "the prompt") {
  return createCliProvider({ spawnFn, timeoutMs: 5000 })({
    system: "system rules",
    user,
    schema,
  });
}

describe("createCliProvider argument construction", () => {
  it("runs `claude` in print mode with the JSON schema, model, appended system prompt, and no tools", async () => {
    const { spawnFn, calls, stdin } = stubSpawn((child) =>
      respond(child, { stdout: successEnvelope(answer) })
    );

    await callProvider(spawnFn, "resume + job description");

    const { command, args } = calls[0];
    expect(command).toBe("claude");
    expect(args).toContain("-p");
    expect(args.slice(args.indexOf("--output-format"))[1]).toBe("json");
    expect(args.slice(args.indexOf("--model"))[1]).toBe("claude-sonnet-5");
    expect(args.slice(args.indexOf("--append-system-prompt"))[1]).toBe("system rules");
    // a pure text transformation: the agent gets no tools, and none of this repo's
    // CLAUDE.md/hooks/MCP config
    expect(args.slice(args.indexOf("--tools"))[1]).toBe("");
    expect(args).toContain("--safe-mode");

    const sentSchema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
    expect(sentSchema.required.sort()).toEqual(["company", "role", "tex"]);
    // the CLI's validator rejects zod's draft-2020-12 $schema ref outright
    expect(sentSchema.$schema).toBeUndefined();

    // the prompt goes on stdin, never argv (a resume + job description + whitelist is far too
    // long for an argument)
    expect(stdin.join("")).toBe("resume + job description");
    expect(args.join(" ")).not.toContain("resume + job description");
  });

  it("never uses a shell, runs outside the repo, and strips ANTHROPIC_API_KEY from the child env", async () => {
    const { spawnFn, calls } = stubSpawn((child) =>
      respond(child, { stdout: successEnvelope(answer) })
    );

    vi.stubEnv("ANTHROPIC_API_KEY", "not-a-real-key");
    try {
      await callProvider(spawnFn);
    } finally {
      vi.unstubAllEnvs();
    }

    const { options } = calls[0];
    expect(options.shell).toBe(false);
    expect(options.cwd).not.toBe(process.cwd());
    // inheriting the key would make the CLI bill the metered API account -- the exact account
    // with no credits that this provider exists to bypass
    expect((options.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY).toBeUndefined();
    expect((options.env as NodeJS.ProcessEnv).PATH).toBe(process.env.PATH);
  });
});

describe("createCliProvider envelope parsing", () => {
  it("returns the parsed structured_output on success", async () => {
    const { spawnFn } = stubSpawn((child) => respond(child, { stdout: successEnvelope(answer) }));
    expect(await callProvider(spawnFn)).toEqual(answer);
  });

  it("falls back to parsing the `result` string when structured_output is absent", async () => {
    const envelope = JSON.stringify({ subtype: "success", result: JSON.stringify(answer) });
    const { spawnFn } = stubSpawn((child) => respond(child, { stdout: envelope }));
    expect(await callProvider(spawnFn)).toEqual(answer);
  });

  it("returns null (retryable) when the payload does not match the schema", async () => {
    const { spawnFn } = stubSpawn((child) =>
      respond(child, { stdout: successEnvelope({ company: "Acme" }) })
    );
    expect(await callProvider(spawnFn)).toBeNull();
  });

  it("throws when the envelope carries neither structured_output nor a JSON result", async () => {
    const envelope = JSON.stringify({ subtype: "success", result: "I could not do that" });
    const { spawnFn } = stubSpawn((child) => respond(child, { stdout: envelope }));
    await expect(callProvider(spawnFn)).rejects.toThrow(ClaudeCliError);
    await expect(callProvider(spawnFn)).rejects.toThrow(/not JSON/i);
  });

  it("throws when stdout is not JSON at all", async () => {
    const { spawnFn } = stubSpawn((child) => respond(child, { stdout: "command not found" }));
    await expect(callProvider(spawnFn)).rejects.toThrow(/not JSON/i);
  });

  it("throws when the CLI reports is_error", async () => {
    const envelope = JSON.stringify({ is_error: true, subtype: "error_during_execution", result: "rate limited" });
    const { spawnFn } = stubSpawn((child) => respond(child, { stdout: envelope }));
    await expect(callProvider(spawnFn)).rejects.toThrow(/reported an error.*rate limited/i);
  });

  it("throws when the CLI ends on a non-success subtype (e.g. hitting max turns)", async () => {
    const envelope = JSON.stringify({ is_error: false, subtype: "error_max_turns" });
    const { spawnFn } = stubSpawn((child) => respond(child, { stdout: envelope }));
    await expect(callProvider(spawnFn)).rejects.toThrow(/reported an error/i);
  });
});

describe("createCliProvider process failures", () => {
  it("surfaces a non-zero exit with the CLI's own stderr", async () => {
    const { spawnFn } = stubSpawn((child) =>
      respond(child, { stderr: "unexpected token in --json-schema", code: 1 })
    );
    await expect(callProvider(spawnFn)).rejects.toThrow(
      /exited with code 1[\s\S]*unexpected token in --json-schema/
    );
  });

  it("names the fix when the CLI is logged out", async () => {
    const { spawnFn } = stubSpawn((child) =>
      respond(child, { stderr: "Invalid API key · Please run /login", code: 1 })
    );
    await expect(callProvider(spawnFn)).rejects.toThrow(
      /not logged in[\s\S]*sign in with your Claude subscription[\s\S]*CLAUDE_PROVIDER=api/
    );
  });

  it("names the fix when the binary is missing, instead of leaking ENOENT", async () => {
    const { spawnFn } = stubSpawn((child) =>
      child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }))
    );
    await expect(callProvider(spawnFn)).rejects.toThrow(
      /Claude Code CLI not found[\s\S]*Install it[\s\S]*CLAUDE_PROVIDER=api/
    );
  });

  it("kills the child and throws when the CLI never answers", async () => {
    // a child that produces nothing and never exits -- the wedged-CLI case
    let child: FakeChild | undefined;
    const { spawnFn } = stubSpawn((c) => {
      child = c;
    });

    const promise = createCliProvider({ spawnFn, timeoutMs: 20 })({
      system: "s",
      user: "u",
      schema,
    });

    await expect(promise).rejects.toThrow(/timed out/i);
    expect(child?.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("ignores the close event that follows a kill, so a timeout is reported once", async () => {
    // the SIGKILL lands after the timeout has already rejected; a second settle would be an
    // unhandled rejection rather than a second error
    const { spawnFn } = stubSpawn((child) => {
      setTimeout(() => child.emit("close", null), 40);
    });

    const promise = createCliProvider({ spawnFn, timeoutMs: 20 })({
      system: "s",
      user: "u",
      schema,
    });

    await expect(promise).rejects.toThrow(/timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});
