/**
 * Desktop SQLite-only Prisma delegates (CloudLink, CloudRecordMap, SyncOperation).
 *
 * The hosted PostgreSQL client is generated from prisma/postgres/schema.prisma,
 * which strips these models (scripts/pg-schema.mjs DESKTOP_ONLY_MODELS). TypeScript
 * on Vercel therefore has no `PrismaClient.cloudLink`. Callers must go through
 * `desktopSync()` so the hosted client typechecks; at runtime these delegates exist
 * only when AHAROS_DESKTOP=1 (SQLite). Hosted `/api/cloud` returns 404 before use.
 */
export type CloudLinkRow = {
  id: string;
  organizationId: string;
  baseUrl: string;
  cloudOutletId: string;
  cloudOutletCode: string;
  localOutletId: string;
  userEmail: string;
  tokenCipher: string | null;
  status: string;
  cursor: string | null;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CloudRecordMapRow = {
  id: string;
  organizationId: string;
  kind: string;
  cloudId: string;
  localId: string;
  revision: string | null;
  issues: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SyncOperationRow = {
  id: string;
  organizationId: string;
  localOrderId: string;
  cloudOrderId: string;
  action: string;
  payload: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  outcome: string | null;
  lastError: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

type Changed = Promise<{ count: number }>;

type RowDelegate<R> = {
  findUnique: (args: object) => Promise<R | null>;
  findUniqueOrThrow: (args: object) => Promise<R>;
  findFirst: (args: object) => Promise<R | null>;
  findMany: (args: object) => Promise<R[]>;
  count: (args?: object) => Promise<number>;
  create: (args: object) => Promise<R>;
  update: (args: object) => Promise<R>;
  updateMany: (args: object) => Changed;
  upsert: (args: object) => Promise<R>;
  delete: (args: object) => Promise<R>;
  deleteMany: (args?: object) => Changed;
};

export type DesktopOnlyDelegates = {
  cloudLink: RowDelegate<CloudLinkRow>;
  cloudRecordMap: RowDelegate<CloudRecordMapRow>;
  syncOperation: RowDelegate<SyncOperationRow>;
};

/** The hosted PrismaClient type does not include these delegates; the SQLite desktop client does. */
export function desktopSync(db: object): DesktopOnlyDelegates {
  return db as DesktopOnlyDelegates;
}
