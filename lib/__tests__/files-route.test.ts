import { describe, expect, it } from "vitest";
import { downloadFilename } from "@/app/api/files/[id]/[kind]/route";
import { RESUME_OWNER_NAME } from "@/lib/config";

describe("downloadFilename", () => {
  it("names the file 'Resume - <owner> <id>' with the requested extension", () => {
    expect(downloadFilename(1, "pdf")).toBe(`Resume - ${RESUME_OWNER_NAME} 1.pdf`);
    expect(downloadFilename(42, "tex")).toBe(`Resume - ${RESUME_OWNER_NAME} 42.tex`);
  });

  it("uses the tracker id, so two tailored versions never collide in a downloads folder", () => {
    expect(downloadFilename(2, "pdf")).not.toBe(downloadFilename(3, "pdf"));
  });

  it("produces a name safe to embed in a quoted Content-Disposition value", () => {
    const name = downloadFilename(7, "pdf");
    expect(name).not.toMatch(/["\\\r\n]/);
  });
});
