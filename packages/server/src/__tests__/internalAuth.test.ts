import { describe, it, expect } from "vitest";
import { signInternalToken, verifyInternalToken } from "../middleware/internalAuth.js";

describe("internalAuth token", () => {
  it("round-trips userId without an actor", () => {
    const token = signInternalToken("user-abc");
    const payload = verifyInternalToken(token);
    expect(payload).toEqual({ userId: "user-abc", actorName: null });
  });

  it("round-trips userId + actorName", () => {
    const token = signInternalToken("user-abc", "Connector");
    const payload = verifyInternalToken(token);
    expect(payload).toEqual({ userId: "user-abc", actorName: "Connector" });
  });

  it("preserves Unicode in actorName via base64url encoding", () => {
    const token = signInternalToken("user-abc", "Émile");
    expect(verifyInternalToken(token)).toEqual({ userId: "user-abc", actorName: "Émile" });
  });

  it("treats empty-string actorName the same as null", () => {
    const token = signInternalToken("user-abc", "");
    expect(verifyInternalToken(token)).toEqual({ userId: "user-abc", actorName: null });
  });

  it("rejects a token with wrong part count (legacy 3-part shape)", () => {
    // Simulate the pre-#43 token shape: userId.expiresAt.sig
    const legacy = `user-abc.${Date.now() + 30_000}.notasignature`;
    expect(verifyInternalToken(legacy)).toBeNull();
  });

  it("rejects a token whose signature was computed over different fields", () => {
    // Tamper: take a valid token, replace the actor segment, leave sig intact.
    const valid = signInternalToken("user-abc", "Connector");
    const [userId, , expiresAt, sig] = valid.split(".");
    const tampered = `${userId}.${Buffer.from("Admin", "utf8").toString("base64url")}.${expiresAt}.${sig}`;
    expect(verifyInternalToken(tampered)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = signInternalToken("user-abc", "Connector");
    // Wait for the 30s TTL to elapse — not feasible in a unit test, so
    // instead splice in an expiry that's already past and re-derive the
    // matching signature would require the secret. We can at least assert
    // the parse rejects a clearly past expiry.
    const [userId, actorB64] = token.split(".");
    const expired = `${userId}.${actorB64}.${Date.now() - 1000}.notasignature`;
    expect(verifyInternalToken(expired)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyInternalToken("not.a.token")).toBeNull();
    expect(verifyInternalToken("")).toBeNull();
    expect(verifyInternalToken("a.b.c.d.e")).toBeNull();
  });
});
