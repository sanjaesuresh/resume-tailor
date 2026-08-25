import { describe, expect, it } from "vitest";
import { currentPathWithSearchAndHash, safeNextPath } from "@/app/components/authRedirect";

describe("auth redirect helpers", () => {
  it("preserves same-origin paths with query strings and hashes", () => {
    expect(safeNextPath("/applications?status=interview#row-3")).toBe(
      "/applications?status=interview#row-3"
    );
  });

  it("rejects external origins and protocol-relative URLs", () => {
    expect(safeNextPath("https://evil.example/settings")).toBe("/");
    expect(safeNextPath("//evil.example/settings")).toBe("/");
  });

  it("rejects backslash-normalized redirect targets", () => {
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/%5Cevil.example")).toBe("/");
  });

  it("rejects signin loops", () => {
    expect(safeNextPath("/signin")).toBe("/");
    expect(safeNextPath("/signin/reset")).toBe("/");
  });

  it("builds the current client path from all location parts", () => {
    const location = {
      pathname: "/applications",
      search: "?status=interview",
      hash: "#row-3",
    } as Location;

    expect(currentPathWithSearchAndHash(location)).toBe("/applications?status=interview#row-3");
  });
});
