import { createGuestRouter } from "@/server/api/guestRouter";
import { RATE_POLICIES } from "@/server/api/rateLimit";
import { guestMenu, quoteGuestCart, placeGuestOrder, getGuestOrder, startGuestPayment, confirmGuestPayment, submitGuestOrderFeedback } from "@/server/services/guestOrdering";
import { feedbackLinkInfo, submitFeedbackByToken } from "@/server/services/feedbackLoop";
import { applyUnsubscribe, unsubscribeInfo } from "@/server/services/consent";
import { prisma } from "@/server/db/client";
import { NotFoundError } from "@/server/db/scope";

export const runtime = "nodejs";

// Anonymous guest QR ordering. Tenant context comes only from the table token
// (server-side lookup); an order is reachable only with its access key, sent in
// the x-order-key header (never in the URL, so it stays out of access logs).
export const { GET, POST } = createGuestRouter([
  { method: "GET", path: "t/:token", handler: ({ params }) => guestMenu(params.token) },
  // Read-only: the cart priced by the server (availability, variants, add-ons, GST). Creates nothing.
  { method: "POST", path: "t/:token/quote", ipPolicy: RATE_POLICIES.guestQuotePerIp, handler: ({ params, body }) => quoteGuestCart(params.token, body) },
  {
    method: "POST", path: "t/:token/orders",
    limits: [{ policy: RATE_POLICIES.guestOrderPerTable, key: ({ params }) => params.token }],
    handler: ({ params, body, req, ip }) => placeGuestOrder(params.token, body, req.headers.get("idempotency-key"), { ip, userAgent: req.headers.get("user-agent") ?? undefined }),
  },
  { method: "GET", path: "orders/:id", handler: ({ params, req }) => getGuestOrder(params.id, req.headers.get("x-order-key")) },
  { method: "POST", path: "orders/:id/payments", handler: ({ params, req, body }) => startGuestPayment(params.id, req.headers.get("x-order-key"), req.headers.get("idempotency-key"), body) },
  { method: "POST", path: "orders/:id/payments/confirm", handler: ({ params, req, body }) => confirmGuestPayment(params.id, req.headers.get("x-order-key"), body) },
  // Group 6. The post-meal rating: from the order page (the order's key) or from the link we sent (its token).
  { method: "POST", path: "orders/:id/feedback", limits: [{ policy: RATE_POLICIES.guestFeedbackPerKey, key: ({ params }) => params.id }], handler: ({ params, req, body }) => submitGuestOrderFeedback(params.id, req.headers.get("x-order-key"), body) },
  { method: "GET", path: "feedback/:token", handler: ({ params }) => feedbackLinkInfo(params.token) },
  { method: "POST", path: "feedback/:token", limits: [{ policy: RATE_POLICIES.guestFeedbackPerKey, key: ({ params }) => params.token }], handler: ({ params, body }) => submitFeedbackByToken(params.token, body) },
  // One-click unsubscribe from marketing (the signed token in every marketing message).
  { method: "GET", path: "unsubscribe/:token", handler: async ({ params }) => { const i = await unsubscribeInfo(prisma, params.token); if (!i) throw new NotFoundError("This link is not valid"); return { restaurant: i.restaurant, channel: i.channel }; } },
  { method: "POST", path: "unsubscribe/:token", ipPolicy: RATE_POLICIES.guestUnsubscribePerIp, handler: async ({ params }) => { const r = await applyUnsubscribe(params.token); if (!r.ok) throw new NotFoundError("This link is not valid"); return { done: true, restaurant: r.restaurant }; } },
]);
