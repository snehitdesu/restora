/**
 * Staff QR scanner, pure rules: which scanned texts are RESTORA table links,
 * which are refused (unsafe schemes, foreign sites, odd paths, bad tokens),
 * duplicate suppression, and camera-error classification. No DB, no DOM.
 */
import { describe, expect, it } from "vitest";
import { GUEST_TABLE_TOKEN_RE, guestTableUrl, isGuestTableToken, maskToken, parseTableQr } from "@/lib/qr/tableQrUrl";
import { GUEST_TABLE_TOKEN_RE as SERVICE_RE, isGuestTableToken as serviceIsToken } from "@/server/services/guestOrdering";
import { CAMERA_CONSTRAINTS, cameraSupportProblem, classifyCameraError, createScanGate, documentAllowsCamera, stopStream } from "@/lib/qr/scanner";

const APP = "https://cafe.example.com";
const TOKEN = "ccAbC-12_xyzXYZ0123456789";

describe("table QR text parsing", () => {
  it("accepts the guest route on a trusted origin and a bare token", () => {
    expect(parseTableQr(`${APP}/t/${TOKEN}`, { trustedOrigins: [APP] })).toEqual({ ok: true, token: TOKEN, origin: APP });
    expect(parseTableQr(`  ${APP}/t/${TOKEN}/  `, { trustedOrigins: [APP] })).toEqual({ ok: true, token: TOKEN, origin: APP });
    expect(parseTableQr(`HTTPS://CAFE.EXAMPLE.COM/t/${TOKEN}`, { trustedOrigins: [APP] })).toEqual({ ok: true, token: TOKEN, origin: APP });
    expect(parseTableQr("http://localhost:3000/t/" + TOKEN, { trustedOrigins: ["http://localhost:3000"] })).toMatchObject({ ok: true, origin: "http://localhost:3000" });
    expect(parseTableQr(TOKEN)).toEqual({ ok: true, token: TOKEN, origin: null });
    // Without a trusted list only the shape is checked (the client pre-check).
    expect(parseTableQr(`https://elsewhere.example/t/${TOKEN}`)).toMatchObject({ ok: true, origin: "https://elsewhere.example" });
  });

  it("refuses unsafe schemes before anything else", () => {
    for (const s of [
      "javascript:alert(1)",
      "JavaScript:alert(document.cookie)",
      `data:text/html,<a href="${APP}/t/${TOKEN}">`,
      "file:///C:/Windows/system.ini",
      `intent://cafe.example.com/t/${TOKEN}#Intent;scheme=https;end`,
      "upi://pay?pa=x@y",
      `ftp://cafe.example.com/t/${TOKEN}`,
      "vbscript:msgbox(1)",
    ]) {
      expect(parseTableQr(s, { trustedOrigins: [APP] }), s).toMatchObject({ ok: false, reason: "unsafe_scheme" });
    }
  });

  it("refuses foreign origins, including look-alikes", () => {
    for (const s of [
      `https://evil.example/t/${TOKEN}`,
      `https://cafe.example.com.evil.example/t/${TOKEN}`,
      `http://cafe.example.com/t/${TOKEN}`, // scheme is part of the origin
      `https://cafe.example.com:8443/t/${TOKEN}`,
      `https://xn--caf-dma.example.com/t/${TOKEN}`,
    ]) {
      expect(parseTableQr(s, { trustedOrigins: [APP] }), s).toMatchObject({ ok: false, reason: "untrusted_origin" });
    }
  });

  it("refuses malformed links, credentials, extra parameters and other paths", () => {
    const cases: Array<[string, string]> = [
      ["", "empty"],
      ["   ", "empty"],
      ["x".repeat(3000), "too_long"],
      ["https://", "malformed_url"],
      ["https:///t/abc", "malformed_url"],
      ["cafe.example.com/t/" + TOKEN, "malformed_url"],
      [`https://cafe example.com/t/${TOKEN}`, "malformed_url"],
      ["/t/" + TOKEN, "malformed_url"],
      [`https://user:pw@cafe.example.com/t/${TOKEN}`, "credentials"],
      [`https://cafe.example.com@evil.example/t/${TOKEN}`, "credentials"],
      [`${APP}/t/${TOKEN}?next=https://evil.example`, "query_or_fragment"],
      [`${APP}/t/${TOKEN}#x`, "query_or_fragment"],
      [`${APP}/t/${TOKEN}?`, "query_or_fragment"],
      [`${APP}/`, "wrong_path"],
      [`${APP}/t/`, "wrong_path"],
      [`${APP}/t/${TOKEN}/cart`, "wrong_path"],
      [`${APP}/o/${TOKEN}`, "wrong_path"],
      [`${APP}/x/t/${TOKEN}`, "wrong_path"],
      [`${APP}/t/../login`, "wrong_path"],
      [`${APP}/t/abc`, "bad_token"],
      [`${APP}/t/${"a".repeat(65)}`, "bad_token"],
      [`${APP}/t/abc%2Fdef12`, "bad_token"],
      [`${APP}/t/%E0%A4%A`, "bad_token"],
      [`${APP}/t/%61bcdefgh`, "bad_token"], // encoded form of a plain token is not what the generator prints
      ["abc", "bad_token"],
      ["tok<script>", "bad_token"],
    ];
    for (const [s, reason] of cases) expect(parseTableQr(s, { trustedOrigins: [APP] }), s.slice(0, 60)).toMatchObject({ ok: false, reason });
    expect(parseTableQr(42 as unknown)).toMatchObject({ ok: false, reason: "empty" });
  });

  it("never echoes the scanned text in a rejection message", () => {
    for (const s of [`https://evil.example/t/${TOKEN}`, `${APP}/t/${TOKEN}?q=1`, `javascript:${TOKEN}`]) {
      const r = parseTableQr(s, { trustedOrigins: [APP] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).not.toContain(TOKEN);
    }
  });

  it("shares one token rule with the guest service, builds the normalized link, and masks tokens", () => {
    expect(SERVICE_RE).toBe(GUEST_TABLE_TOKEN_RE);
    expect(serviceIsToken).toBe(isGuestTableToken);
    expect(guestTableUrl(`${APP}/`, TOKEN)).toBe(`${APP}/t/${TOKEN}`);
    expect(() => guestTableUrl("javascript:alert(1)", TOKEN)).toThrow();
    expect(() => guestTableUrl(APP, "bad token")).toThrow();
    expect(maskToken(TOKEN)).toBe("••••789");
    expect(maskToken(TOKEN)).not.toContain(TOKEN.slice(0, 6));
  });
});

describe("scanner helpers", () => {
  it("suppresses the same code while it stays in view, and anything while a check runs", () => {
    const gate = createScanGate(3000);
    expect(gate.accept("A", 1000)).toBe(true);
    expect(gate.accept("A", 1100)).toBe(false);
    expect(gate.accept("A", 3999)).toBe(false);
    expect(gate.accept("A", 4001)).toBe(true);
    gate.setBusy(true);
    expect(gate.accept("B", 5000)).toBe(false);
    gate.setBusy(false);
    expect(gate.accept("B", 5001)).toBe(true);
    gate.reset();
    expect(gate.accept("B", 5002)).toBe(true);
  });

  it("classifies camera failures into what the person can do", () => {
    expect(classifyCameraError({ name: "NotAllowedError" })).toBe("denied");
    expect(classifyCameraError({ name: "SecurityError" })).toBe("denied");
    expect(classifyCameraError({ name: "NotFoundError" })).toBe("unavailable");
    expect(classifyCameraError({ name: "OverconstrainedError" })).toBe("unavailable");
    expect(classifyCameraError({ name: "NotReadableError" })).toBe("busy");
    expect(classifyCameraError(new Error("x"))).toBe("error");
    expect(classifyCameraError(null)).toBe("error");
    expect(cameraSupportProblem({ isSecureContext: false, mediaDevices: { getUserMedia: async () => ({}) as MediaStream } })).toBe("insecure");
    expect(cameraSupportProblem({ isSecureContext: true, mediaDevices: undefined })).toBe("unsupported");
    expect(cameraSupportProblem({ isSecureContext: true, mediaDevices: {} })).toBe("unsupported");
    expect(cameraSupportProblem({ isSecureContext: true, mediaDevices: { getUserMedia: async () => ({}) as MediaStream } })).toBeNull();
    expect(cameraSupportProblem({ isSecureContext: true, mediaDevices: { getUserMedia: async () => ({}) as MediaStream }, policyAllowsCamera: false })).toBe("blocked");
    expect(cameraSupportProblem({ isSecureContext: true, mediaDevices: { getUserMedia: async () => ({}) as MediaStream }, policyAllowsCamera: null })).toBeNull();
  });

  it("reads the document's camera policy where the browser exposes it", () => {
    expect(documentAllowsCamera({ permissionsPolicy: { allowsFeature: (f: string) => f !== "camera" } })).toBe(false);
    expect(documentAllowsCamera({ featurePolicy: { allowsFeature: () => true } })).toBe(true);
    expect(documentAllowsCamera({})).toBeNull();
    expect(documentAllowsCamera(undefined)).toBeNull();
    expect(documentAllowsCamera({ permissionsPolicy: { allowsFeature: () => { throw new Error("x"); } } })).toBeNull();
  });

  it("asks for the rear camera, video only, and stops every track", () => {
    expect(CAMERA_CONSTRAINTS.audio).toBe(false);
    expect((CAMERA_CONSTRAINTS.video as MediaTrackConstraints).facingMode).toEqual({ ideal: "environment" });
    const stops: number[] = [];
    const stream = { getTracks: () => [{ stop: () => stops.push(1) }, { stop: () => { stops.push(2); throw new Error("already"); } }] } as unknown as MediaStream;
    stopStream(stream);
    stopStream(null);
    expect(stops).toEqual([1, 2]);
  });
});
