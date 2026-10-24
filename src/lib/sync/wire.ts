/**
 * Wire format between the cloud sync API (/api/sync/*) and the desktop sync runner.
 * Shared by both sides so the contract cannot drift. Money and quantities travel as
 * decimal strings (never floats); times as ISO-8601 UTC.
 */
import { z } from "zod";

export const SYNC_SOURCES = ["QR", "ONLINE"] as const;
/** Operations the desktop may send. Everything else on a cloud order is done on the hosted POS. */
export const SYNC_ACTIONS = ["ACCEPT", "KOT_STATUS"] as const;
export type SyncAction = (typeof SYNC_ACTIONS)[number];
export const SYNC_OUTCOMES = ["APPLIED", "ALREADY", "SUPERSEDED", "CONFLICT"] as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

export type WireModifier = { name: string; priceDelta: string };
export type WireItem = {
  id: string;
  /** The cloud MenuItem's name: the natural key the desktop maps onto its own menu. */
  menuItemName: string | null;
  name: string;
  qty: string;
  unitPrice: string;
  discount: string;
  taxPct: string;
  lineTotal: string;
  station: string;
  notes: string | null;
  hsnSac: string | null;
  modifiers: WireModifier[];
};
export type WireKot = {
  id: string;
  number: number;
  station: string | null;
  status: string;
  createdAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  servedAt: string | null;
  items: Array<{ orderItemId: string | null; name: string; qty: string; status: string }>;
};
export type WirePayment = { id: string; method: string; status: string; amount: string; verifiedAt: string | null; createdAt: string };
export type WireOrder = {
  id: string;
  /** The reference staff and guests see (#ABC123): derived from the cloud id. */
  ref: string;
  outletId: string;
  status: string;
  channel: string;
  source: string;
  tableCode: string | null;
  covers: number;
  /** Guest's first name / label and their note. The phone number is not part of the feed. */
  guestName: string | null;
  notes: string | null;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  items: WireItem[];
  kots: WireKot[];
  payments: WirePayment[];
  /** Hash of everything above that can change: equal revision = nothing to re-mirror. */
  revision: string;
};

export type WireFeed = { orders: WireOrder[]; nextCursor: string | null; hasMore: boolean; serverTime: string };
export type WireOutlet = { id: string; code: string; name: string };
/** The paired outlet's guest QR tokens by table code, and the cloud's public address (its PUBLIC_BASE_URL, if set). */
export type WireGuestQr = { outletId: string; guestBaseUrl: string | null; tables: Array<{ code: string; qrToken: string }>; commonQrToken: string | null };

const opId = z.string().min(8).max(100).regex(/^[\w.:-]+$/);
/** Who on the desktop took the action: kept on the cloud receipt for traceability, never used for authorization. */
const actorLabel = z.string().trim().max(80).optional();

export const syncOpSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ACCEPT"), opId: opId, orderId: z.string().min(1).max(64), actorLabel }),
  z.object({
    action: z.literal("KOT_STATUS"),
    opId,
    orderId: z.string().min(1).max(64),
    actorLabel,
    kotId: z.string().min(1).max(64),
    to: z.enum(["ACCEPTED", "PREPARING", "READY", "SERVED"]),
  }),
]);
export type SyncOpInput = z.infer<typeof syncOpSchema>;
export type SyncOpResult = { opId: string; outcome: SyncOutcome; detail: string | null; replayed: boolean; order: WireOrder };
