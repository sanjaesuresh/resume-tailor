import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/preview/route";
import { ASSETS_DIR } from "@/lib/config";

// stubbed so these tests exercise compilation, not sessions -- the real requireUser builds a
// better-auth instance, which needs BETTER_AUTH_SECRET and opens the database. The route's
// own auth gate is covered where it belongs, alongside the other access-control assertions.
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ ok: true, user: { id: "u1", email: "a@b.c", name: null } })),
}));

// the committed sample (never the user's real, gitignored resume) -- same fixture the compile and
// approve tests use, so these exercise the real tectonic binary rather than a mock
const validTex = fs.readFileSync(path.join(ASSETS_DIR, "base-resume.sample.tex"), "utf-8");

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/preview", () => {
  it(
    "returns the compiled PDF bytes inline",
    async () => {
      const response = await post({ tex: validTex });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      // a draft preview must never be cached -- the next regenerate invalidates it
      expect(response.headers.get("cache-control")).toBe("no-store");

      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(1000);
      // real PDF, not an error page that happened to get a 200
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    },
    60000
  );

  it(
    "returns 422 with the compile log when the document does not build",
    async () => {
      // unterminated verbatim right before \end{document}: a fast, reliable tectonic failure
      const brokenTex = validTex.replace("\\end{document}", "\\begin{verbatim}\n\\end{document}");
      expect(brokenTex).not.toBe(validTex);

      const response = await post({ tex: brokenTex });

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toMatch(/compilation failed/i);
      // the log is what makes the failure actionable in the preview pane
      expect(typeof body.log).toBe("string");
      expect(body.log.length).toBeGreaterThan(0);
    },
    60000
  );

  it("rejects a missing or blank tex without invoking the compiler", async () => {
    for (const body of [{}, { tex: "" }, { tex: "   " }, { tex: 42 }]) {
      const response = await post(body);
      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe("Missing tex");
    }
  });

  it("rejects a malformed request body", async () => {
    const response = await POST(
      new Request("http://localhost/api/preview", { method: "POST", body: "not json" })
    );

    expect(response.status).toBe(422);
  });
});
