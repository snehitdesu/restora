/**
 * The one source of table QR tokens.
 *
 * A token is the only thing an anonymous guest presents, so it must not be
 * guessable from anything public: never a table code, table id, outlet,
 * organization name or constant. 18 bytes from the OS CSPRNG (144 bits),
 * base64url-encoded to 24 characters that satisfy GUEST_TABLE_TOKEN_RE.
 *
 * Uniqueness: the schema's unique index on RestaurantTable.qrToken is the
 * final guarantee. issueTableQrToken additionally skips a value already held
 * by another table, so a (practically impossible) collision regenerates
 * instead of failing the rotation.
 */
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ConflictError } from "@/server/db/scope";

export const TABLE_QR_TOKEN_BYTES = 18;
const ISSUE_ATTEMPTS = 5;

export function newTableQrToken(): string {
  return randomBytes(TABLE_QR_TOKEN_BYTES).toString("base64url");
}

/** A random token no table currently holds. `source` is replaceable only so tests can force a collision. */
export async function issueTableQrToken(db: PrismaClient | Prisma.TransactionClient, source: () => string = newTableQrToken): Promise<string> {
  for (let i = 0; i < ISSUE_ATTEMPTS; i++) {
    const token = source();
    if (!(await db.restaurantTable.findUnique({ where: { qrToken: token }, select: { id: true } }))) return token;
  }
  throw new ConflictError("Could not issue a unique table QR token; try again");
}
