import { afterEach, describe, expect, it } from "vitest";
import { assertAuthRuntimeConfig, resolveAuthBaseURL } from "../auth";

const originalNodeEnv = process.env.NODE_ENV;
const originalAuthUrl = process.env.BETTER_AUTH_URL;
const originalAuthSecret = process.env.BETTER_AUTH_SECRET;

function restoreEnv(): void {
  setNodeEnv(originalNodeEnv);
  if (originalAuthUrl === undefined) {
    delete process.env.BETTER_AUTH_URL;
  } else {
    process.env.BETTER_AUTH_URL = originalAuthUrl;
  }
  if (originalAuthSecret === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = originalAuthSecret;
  }
}

function setNodeEnv(value: typeof process.env.NODE_ENV): void {
  Object.defineProperty(process.env, "NODE_ENV", {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

describe("auth runtime config", () => {
  afterEach(restoreEnv);

  it("keeps the localhost fallback outside production", () => {
    setNodeEnv("test");
    delete process.env.BETTER_AUTH_URL;

    expect(resolveAuthBaseURL()).toBe("http://localhost:3000");
  });

  it("fails closed when BETTER_AUTH_URL is missing in production", () => {
    setNodeEnv("production");
    delete process.env.BETTER_AUTH_URL;

    expect(() => resolveAuthBaseURL()).toThrow(/BETTER_AUTH_URL is not set/);
  });

  it("trims and returns an explicit BETTER_AUTH_URL", () => {
    setNodeEnv("production");
    process.env.BETTER_AUTH_URL = " https://resume.example.com ";

    expect(resolveAuthBaseURL()).toBe("https://resume.example.com");
  });

  it("reports a missing BETTER_AUTH_SECRET to health checks", () => {
    setNodeEnv("test");
    delete process.env.BETTER_AUTH_SECRET;

    expect(() => assertAuthRuntimeConfig()).toThrow(/BETTER_AUTH_SECRET is not set/);
  });
});
