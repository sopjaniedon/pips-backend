import { describe, expect, it } from "vitest";
import { checkToken, issueToken, looksLikeSpam } from "./antispam.js";

const S = "x".repeat(40);
describe("form time token", () => {
  const t0 = 1_800_000_000_000;
  const tok = issueToken(S, "contact", t0);
  it("accepts a token after the minimum time", () => expect(checkToken(S, "contact", tok, t0 + 5_000)).toBe("ok"));
  it("rejects instant submissions", () => expect(checkToken(S, "contact", tok, t0 + 500)).toBe("too-fast"));
  it("rejects old tokens", () => expect(checkToken(S, "contact", tok, t0 + 4 * 24 * 3600_000)).toBe("expired"));
  it("rejects another form's token", () => expect(checkToken(S, "sop-application-sq", tok, t0 + 5_000)).toBe("invalid"));
  it("rejects a tampered token", () => expect(checkToken(S, "contact", tok.replace(/\.\d+\./, `.${t0 - 60_000}.`), t0 + 5_000)).toBe("invalid"));
  it("rejects a missing token", () => expect(checkToken(S, "contact", undefined)).toBe("missing"));
});

describe("spam heuristic", () => {
  it("flags link-heavy messages", () => expect(looksLikeSpam("hi", "http://a.example http://b.example")).toBe(true));
  it("keeps normal messages", () => expect(looksLikeSpam("Pyetje", "A mund të aplikoj për Shkollën Politike?")).toBe(false));
});
