import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptField, encryptField, mask, valueAad, type Keyring } from "./crypto.js";

const ring = (): Keyring => ({ keys: { k1: randomBytes(32), k2: randomBytes(32) }, activeKid: "k1" });

describe("field encryption", () => {
  it("round-trips with the right key and associated data", () => {
    const r = ring();
    const { enc, kid } = encryptField(r, "P01234567", valueAad(5, 53));
    expect(decryptField(r, enc, kid, valueAad(5, 53))).toBe("P01234567");
  });

  it("never stores plaintext and uses a fresh IV each time", () => {
    const r = ring();
    const a = encryptField(r, "P01234567", "x").enc, b = encryptField(r, "P01234567", "x").enc;
    expect(a.includes(Buffer.from("P01234567"))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a value moved to another row or field", () => {
    const r = ring();
    const { enc, kid } = encryptField(r, "P01234567", valueAad(5, 53));
    expect(() => decryptField(r, enc, kid, valueAad(6, 53))).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const r = ring();
    const { enc, kid } = encryptField(r, "P01234567", "x");
    enc[enc.length - 1] ^= 1;
    expect(() => decryptField(r, enc, kid, "x")).toThrow();
  });

  it("decrypts old values after the active key rotates", () => {
    const r = ring();
    const { enc, kid } = encryptField(r, "old", "x");
    r.activeKid = "k2";
    expect(decryptField(r, enc, kid, "x")).toBe("old");
  });

  it("masks all but the last characters", () => {
    expect(mask("P01234567")).toBe("••••••567");
    expect(mask("")).toBe("");
  });
});
