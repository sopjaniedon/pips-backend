import { describe, expect, it } from "vitest";
import { accepts, sniff } from "./sniff.js";

describe("upload sniffing", () => {
  it("detects PDF by content", () => expect(sniff(Buffer.from("%PDF-1.7\n"), "x.bin")?.mime).toBe("application/pdf"));
  it("detects PNG", () => expect(sniff(Buffer.from("89504e470d0a1a0a", "hex"), "a.png")?.ext).toBe("png"));
  it("detects HEIC", () => expect(sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")]), "a.heic")?.mime).toBe("image/heic"));
  it("needs a .docx name for zip files", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(sniff(zip, "cv.docx")?.ext).toBe("docx");
    expect(sniff(zip, "cv.zip")).toBeNull();
  });
  it("rejects executables named .pdf", () => expect(sniff(Buffer.from("MZ\x90\x00"), "cv.pdf")).toBeNull());
  it("matches DigForm accept lists", () => {
    expect(accepts("image/*", "image/heic")).toBe(true);
    expect(accepts("application/msword,application/pdf", "image/png")).toBe(false);
    expect(accepts("", "image/png")).toBe(true);
  });
});
