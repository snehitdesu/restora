import { createHash } from "node:crypto";

export type MirrorKind = "ORDER" | "ORDER_ITEM" | "KOT" | "PAYMENT";

/**
 * The local primary key of a record mirrored from the cloud. Deterministic within one local organization (the same
 * cloud record always lands on the same local row, so a crash between "row written" and "mapping written" cannot
 * produce a duplicate). It is scoped by organizationId so two installations sharing one SQLite file — or a test
 * database that holds both the cloud restaurant and a desktop — never collide on Order/KOT/Payment ids. The value
 * ends with the cloud id's last six characters, so the short reference staff read out (#ABC123) is identical on the
 * hosted POS and on the desktop. This is a naming convention, NOT an identity assumption: the CloudRecordMap table
 * is the source of truth for which local row belongs to which cloud record.
 */
export function mirrorId(kind: MirrorKind, cloudId: string, organizationId: string): string {
  return `mx${createHash("sha256").update(`${kind}:${organizationId}:${cloudId}`).digest("hex").slice(0, 17)}${cloudId.slice(-6)}`;
}
