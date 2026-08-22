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

  it("prefers the owner's saved display name over the deployment-wide env default", () => {
    expect(downloadFilename(5, "pdf", "Ada Lovelace")).toBe("Resume - Ada Lovelace 5.pdf");
  });

  it("supplies the 'Resume - ' prefix and the id itself, so the name is just the name", () => {
    // a user who types their whole desired filename into the display-name field would otherwise
    // get "Resume - Resume - Ada Lovelace 5.pdf"; this pins what the field is actually for
    expect(downloadFilename(5, "pdf", "Ada Lovelace")).toBe("Resume - Ada Lovelace 5.pdf");
    expect(downloadFilename(5, "pdf", "Resume - Ada Lovelace")).toBe(
      "Resume - Resume - Ada Lovelace 5.pdf"
    );
  });

  it("falls back to the env default for an account with no display name set", () => {
    for (const empty of [null, undefined, "   "]) {
      expect(downloadFilename(9, "tex", empty)).toBe(`Resume - ${RESUME_OWNER_NAME} 9.tex`);
    }
  });

  it("still sanitises a display name that reached it unvalidated", () => {
    // settings validation strips these already, but this is the last point before a header
    expect(downloadFilename(1, "pdf", 'Ada"\\\r\nLovelace')).not.toMatch(/["\\\r\n]/);
  });
});
