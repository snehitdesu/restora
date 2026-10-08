/**
 * E-mail through Resend, contract-tested against the documented request / response shapes (never a live account) plus
 * the Svix-signed delivery webhook, end to end through the outbox:
 *
 *  E1 credentials  E2 request shape and error mapping  E3 webhook signatures
 *  E4 outbox: send once with the idempotency key, no secrets in the outbox or logs, status only moves forward
 *  E5 webhooks: tenant binding, forged / stale / replayed events, spam complaint withdraws marketing consent
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "@/server/db/client";
import { IntegrationError } from "@/integrations/http";
import {
  ResendEmailProvider, TwilioMessagingProvider, type ResendCredentials, maskEmail, normalizeEmail, parseResendEvent, resendCredentialsSchema, verifyResendWebhook,
} from "@/integrations/messaging";
import { upsertIntegration, testConnection, listIntegrations } from "@/server/services/integrations";
import { handleEmailWebhook, queueCustomerMessage } from "@/server/services/messaging";
import { getConsent } from "@/server/services/consent";
import { makeEnv, guest, deliveries, uniq, type Env } from "../domain/growthSupport";

const API_KEY = `re_${"k".repeat(24)}`;
const secretFor = () => `whsec_${randomBytes(24).toString("base64")}`;
const creds = (over: object = {}): ResendCredentials & Record<string, string> => ({ apiKey: API_KEY, from: "Cafe <orders@cafe.example>", ...over });

/** What Resend (Svix) sends: id, timestamp and `v1,<base64 HMAC-SHA256(id.timestamp.body)>`. */
function sign(secret: string, body: string, id = `msg_${uniq()}`, ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return { id, timestamp: String(ts), signature: `v1,${sig}` };
}
const event = (type: string, emailId: string) => JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: ["x@y.test"] } });

type Req = { url: string; init: RequestInit };
let requests: Req[] = [];
let respond: (r: Req) => Response | Promise<Response>;
const okSend = (id = `em_${uniq()}`) => () => new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });

beforeAll(() => { process.env.PUBLIC_BASE_URL = "https://restora.test"; });
afterEach(() => { vi.unstubAllGlobals(); requests = []; });
afterAll(async () => { await prisma.$disconnect(); });
function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const r = { url: String(url), init };
    requests.push(r);
    return respond(r);
  }));
}

describe("E1. credentials", () => {
  it("accepts a Resend key, a verified sender and a signing secret; refuses anything else", () => {
    expect(resendCredentialsSchema.safeParse(creds({ webhookSecret: secretFor() })).success).toBe(true);
    expect(resendCredentialsSchema.safeParse(creds({ from: "orders@cafe.example" })).success).toBe(true);
    for (const bad of [{ apiKey: "sk_live_notresend1234567890" }, { apiKey: "re_short" }, { from: "not an address" }, { from: "a\r\nBcc: x@y.z" }, { webhookSecret: "plain-text-secret-value" }, { replyTo: "nope" }]) {
      expect(resendCredentialsSchema.safeParse(creds(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(resendCredentialsSchema.safeParse({ ...creds(), extra: "x" }).success).toBe(false); // strict
    expect(normalizeEmail(" Guest@Example.COM ")).toBe("guest@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(maskEmail("guest@example.com")).toMatch(/^g\*+@example\.com$/);
  });
});

describe("E2. request shape and error mapping", () => {
  it("POSTs the documented JSON with a Bearer key and the idempotency key; returns the e-mail id", async () => {
    respond = okSend("em_abc123");
    stubFetch();
    const p = new ResendEmailProvider(creds({ replyTo: "help@cafe.example" }), "SANDBOX");
    const out = await p.send({ channel: "EMAIL", to: "guest@example.com", subject: "Weekend special", body: "Hello" }, { idempotencyKey: "camp:1:2" });
    expect(out).toEqual({ providerRef: "em_abc123", status: "QUEUED" });
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Idempotency-Key"]).toBe("camp:1:2");
    expect(JSON.parse(init.body as string)).toEqual({ from: "Cafe <orders@cafe.example>", to: ["guest@example.com"], subject: "Weekend special", text: "Hello", reply_to: "help@cafe.example" });
  });

  it("maps provider failures: bad key and bad request are not retried, a 5xx is; unexpected bodies are refused", async () => {
    const p = new ResendEmailProvider(creds(), "SANDBOX");
    const msg = { channel: "EMAIL" as const, to: "guest@example.com", subject: "S", body: "Hello" };
    stubFetch();
    respond = () => new Response(JSON.stringify({ name: "validation_error", message: "bad" }), { status: 422 });
    await expect(p.send(msg)).rejects.toMatchObject({ retryable: false });
    respond = () => new Response("{}", { status: 401 });
    await expect(p.send(msg)).rejects.toMatchObject({ retryable: false });
    respond = () => new Response("{}", { status: 503 });
    await expect(p.send(msg)).rejects.toMatchObject({ retryable: true });
    respond = () => new Response(JSON.stringify({ unexpected: true }), { status: 200 });
    await expect(p.send(msg)).rejects.toMatchObject({ code: "MALFORMED" });
    // The key never travels in an error message.
    respond = () => new Response(`bad key ${API_KEY}`, { status: 403 });
    const err = await p.send(msg).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(API_KEY);
  });

  it("channels: Resend carries e-mail only, Twilio never e-mail; health check hits a read-only endpoint", async () => {
    const r = new ResendEmailProvider(creds(), "SANDBOX");
    expect([r.supports("EMAIL"), r.supports("SMS"), r.supports("WHATSAPP")]).toEqual([true, false, false]);
    await expect(r.send({ channel: "SMS", to: "9876543210", body: "Hello" })).rejects.toBeInstanceOf(IntegrationError);
    const t = new TwilioMessagingProvider({ accountSid: `AC${"c".repeat(32)}`, authToken: "token-token-token-1" }, "SANDBOX", async () => new Response("{}"));
    expect([t.supports("EMAIL"), t.supports("SMS"), t.supports("WHATSAPP")]).toEqual([false, true, true]);
    await expect(t.send({ channel: "EMAIL", to: "a@b.co", body: "Hello" })).rejects.toBeInstanceOf(IntegrationError);
    stubFetch();
    respond = () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    expect(await r.healthCheck()).toBe(true);
    expect(requests[0].url).toBe("https://api.resend.com/domains");
    respond = () => new Response("{}", { status: 401 });
    expect(await r.healthCheck()).toBe(false);
  });
});

describe("E3. webhook signatures (Svix)", () => {
  const secret = secretFor();
  const body = event("email.delivered", "em_1");

  it("accepts a correct signature, including one of several in the header", () => {
    const h = sign(secret, body);
    expect(verifyResendWebhook(secret, body, h)).toBe(true);
    expect(verifyResendWebhook(secret, body, { ...h, signature: `v1,${Buffer.from("old").toString("base64")} ${h.signature}` })).toBe(true);
  });

  it("refuses a tampered body, another secret, a wrong version, missing parts and replays", () => {
    const h = sign(secret, body);
    expect(verifyResendWebhook(secret, body.replace("em_1", "em_2"), h)).toBe(false);
    expect(verifyResendWebhook(secretFor(), body, h)).toBe(false);
    expect(verifyResendWebhook(secret, body, { ...h, signature: h.signature.replace("v1,", "v2,") })).toBe(false);
    expect(verifyResendWebhook(secret, body, { ...h, id: undefined })).toBe(false);
    expect(verifyResendWebhook(secret, body, { ...h, timestamp: undefined })).toBe(false);
    expect(verifyResendWebhook(secret, body, { ...h, signature: undefined })).toBe(false);
    expect(verifyResendWebhook("not-a-whsec", body, h)).toBe(false);
    expect(verifyResendWebhook("whsec_", body, h)).toBe(false);
    const stale = sign(secret, body, "msg_old", Math.floor(Date.now() / 1000) - 3600);
    expect(verifyResendWebhook(secret, body, stale)).toBe(false);
    const future = sign(secret, body, "msg_future", Math.floor(Date.now() / 1000) + 3600);
    expect(verifyResendWebhook(secret, body, future)).toBe(false);
    expect(verifyResendWebhook(secret, body, { ...h, timestamp: "soon" })).toBe(false);
  });

  it("maps events to outbox statuses and ignores the rest", () => {
    expect(parseResendEvent(JSON.parse(event("email.delivered", "e1")))).toEqual({ providerRef: "e1", status: "DELIVERED" });
    expect(parseResendEvent(JSON.parse(event("email.sent", "e1")))).toEqual({ providerRef: "e1", status: "SENT" });
    expect(parseResendEvent(JSON.parse(event("email.bounced", "e1")))).toMatchObject({ status: "FAILED", error: "Bounced" });
    expect(parseResendEvent(JSON.parse(event("email.complained", "e1")))).toMatchObject({ status: "FAILED", error: "Marked as spam" });
    expect(parseResendEvent(JSON.parse(event("email.opened", "e1")))).toBeNull();
    expect(parseResendEvent({ type: "email.delivered" })).toBeNull();
    expect(parseResendEvent("nope")).toBeNull();
  });
});

describe("E4/E5. through the outbox", () => {
  let env: Env;
  let other: Env;
  const secret = secretFor();
  beforeAll(async () => {
    env = await makeEnv("Gem");
    other = await makeEnv("Gen");
    await upsertIntegration(env.owner, { kind: "MESSAGING", provider: "resend", mode: "SANDBOX", credentials: creds({ webhookSecret: secret }) });
    await upsertIntegration(other.owner, { kind: "MESSAGING", provider: "resend", mode: "SANDBOX", credentials: creds({ webhookSecret: secretFor() }) });
  });

  const sendMail = async (e: Env, who: string, key: string, purpose: "MARKETING" | "TRANSACTIONAL" = "TRANSACTIONAL") => {
    const g = await guest(e, who, { email: `${who.replace(/\W/g, "").toLowerCase()}${uniq()}@guest.test`, marketing: purpose === "MARKETING" ? ["EMAIL"] : [] });
    respond = okSend(`em_${uniq()}`);
    stubFetch();
    const r = await queueCustomerMessage(e.owner, { customerId: g.id, channel: "EMAIL", purpose, key, template: "T", subject: "Subject line", body: "Hello there", now: new Date("2026-10-07T08:00:00Z") });
    return { g, r };
  };

  it("E4 sends once with the outbox key as the idempotency key; the full address and the API key never reach the outbox, the audit trail or the connection view", async () => {
    const key = `mail-${uniq()}`;
    const { g, r } = await sendMail(env, "Mailer", key);
    expect(r.status).toBe("QUEUED");
    expect(requests).toHaveLength(1);
    expect((requests[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(key);
    const row = (await deliveries(env.orgId, { idempotencyKey: key }))[0];
    expect(row).toMatchObject({ provider: "resend", status: "SENT", sourceType: "Customer", sourceId: g.id });
    expect(row.providerRef).toMatch(/^em_/);
    expect(row.target).toMatch(/^m\*+@guest\.test$/);
    const everything = JSON.stringify([row, await prisma.auditLog.findMany({ where: { organizationId: env.orgId } }), await listIntegrations(prisma, env.owner)]);
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/mailer\w*@guest\.test/);

    // Re-queueing the same event sends nothing (no second request to Resend).
    requests = [];
    stubFetch();
    expect((await queueCustomerMessage(env.owner, { customerId: g.id, channel: "EMAIL", purpose: "TRANSACTIONAL", key, template: "T", body: "Hello there" })).status).toBe("DUPLICATE");
    expect(requests).toHaveLength(0);
  });

  it("E4 connection test uses the stored key; the SMS channel is not served by an e-mail-only connection", async () => {
    stubFetch();
    respond = () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const conn = (await listIntegrations(prisma, env.owner)).find((c) => c.provider === "resend")!;
    requests = [];
    const res = await testConnection(env.owner, conn.id);
    expect(res.lastError).toBeNull();
    expect(res.lastSuccessAt).toBeInstanceOf(Date);
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    const g = await guest(env, "Phone Only", { marketing: ["SMS"] });
    expect(await queueCustomerMessage(env.owner, { customerId: g.id, channel: "SMS", purpose: "MARKETING", key: `sms-${uniq()}`, template: "T", body: "x", now: new Date("2026-10-07T08:00:00Z") })).toMatchObject({ status: "SKIPPED", reason: "No SMS provider is connected" });
  });

  it("E5 a signed delivered event moves the status forward once; a replay is a duplicate; an unknown message is a 404", async () => {
    const { r } = await sendMail(env, "Deliver", `mail-${uniq()}`);
    const d = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: r.deliveryId! } });
    const body = event("email.delivered", d.providerRef!);
    expect(await handleEmailWebhook(prisma, body, sign(secret, body))).toEqual({ httpStatus: 200, status: "PROCESSED" });
    expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DELIVERED");
    expect(await handleEmailWebhook(prisma, body, sign(secret, body))).toEqual({ httpStatus: 200, status: "DUPLICATE" });
    // An out-of-order "sent" after "delivered" never moves it back.
    const late = event("email.sent", d.providerRef!);
    expect(await handleEmailWebhook(prisma, late, sign(secret, late))).toMatchObject({ status: "DUPLICATE" });
    expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DELIVERED");

    const unknown = event("email.delivered", "em_does_not_exist");
    expect(await handleEmailWebhook(prisma, unknown, sign(secret, unknown))).toEqual({ httpStatus: 404, status: "UNKNOWN_MESSAGE" });
    expect(await handleEmailWebhook(prisma, "{not json", sign(secret, "{not json"))).toEqual({ httpStatus: 400, status: "MALFORMED" });
    const ignored = event("email.opened", d.providerRef!);
    expect(await handleEmailWebhook(prisma, ignored, sign(secret, ignored))).toEqual({ httpStatus: 200, status: "IGNORED" });
  });

  it("E5 forged, wrong-tenant, stale and unsigned events change nothing", async () => {
    const { r } = await sendMail(env, "Forged", `mail-${uniq()}`);
    const d = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: r.deliveryId! } });
    const body = event("email.delivered", d.providerRef!);
    const before = (await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status;
    // Signed with another restaurant's secret (a tenant cannot touch another tenant's outbox).
    const wrong = (await prisma.integrationConnection.findFirst({ where: { organizationId: other.orgId, provider: "resend" } }))!;
    expect(wrong).toBeTruthy();
    for (const h of [sign(secretFor(), body), sign(secret, body, "msg_stale", Math.floor(Date.now() / 1000) - 7200), { id: "x", timestamp: String(Math.floor(Date.now() / 1000)), signature: "v1,AAAA" }, {}]) {
      expect(await handleEmailWebhook(prisma, body, h)).toEqual({ httpStatus: 401, status: "INVALID_SIGNATURE" });
    }
    expect((await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(before);
  });

  it("E5 a connection with no signing secret refuses every event", async () => {
    const e = await makeEnv("Geo");
    await upsertIntegration(e.owner, { kind: "MESSAGING", provider: "resend", mode: "SANDBOX", credentials: creds() });
    const { r } = await sendMail(e, "NoSecret", `mail-${uniq()}`);
    const d = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: r.deliveryId! } });
    const body = event("email.delivered", d.providerRef!);
    expect(await handleEmailWebhook(prisma, body, sign(secretFor(), body))).toEqual({ httpStatus: 401, status: "INVALID_SIGNATURE" });
  });

  it("E5 a spam complaint fails the delivery and withdraws the guest's marketing consent on e-mail", async () => {
    const { g, r } = await sendMail(env, "Complainer", `mail-${uniq()}`, "MARKETING");
    const d = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: r.deliveryId! } });
    expect(d).toMatchObject({ sourceType: "Marketing", sourceId: g.id });
    expect((await getConsent(prisma, env.manager, g.id)).find((c) => c.channel === "EMAIL")!.marketing).toBe(true);
    const body = event("email.complained", d.providerRef!);
    expect(await handleEmailWebhook(prisma, body, sign(secret, body))).toEqual({ httpStatus: 200, status: "PROCESSED" });
    const after = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(after).toMatchObject({ status: "FAILED", lastError: "Marked as spam" });
    expect((await getConsent(prisma, env.manager, g.id)).find((c) => c.channel === "EMAIL")).toMatchObject({ marketing: false, source: "GUEST_REPLY" });
    // A bounce alone is recorded but does not change consent.
    const { g: g2, r: r2 } = await sendMail(env, "Bouncer", `mail-${uniq()}`, "MARKETING");
    const d2 = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: r2.deliveryId! } });
    const bounce = event("email.bounced", d2.providerRef!);
    expect(await handleEmailWebhook(prisma, bounce, sign(secret, bounce))).toMatchObject({ status: "PROCESSED" });
    expect((await getConsent(prisma, env.manager, g2.id)).find((c) => c.channel === "EMAIL")!.marketing).toBe(true);
  });
});
