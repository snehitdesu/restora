/**
 * The kitchen board polls every few seconds from every kitchen screen. Sliding a
 * kitchen session's idle window must not cost a database write on each poll: on
 * SQLite an UPDATE takes the single write lock even when it matches no row, and
 * ~10 screens polling at once stalled ticket updates behind those lock waits
 * until the 5 s busy timeout (measured: KDS list answered 503, updates took 5–12 s).
 */
import { describe, it, expect, vi } from "vitest";
import { recordSessionActivity, validateSession, ACTIVITY_WRITE_INTERVAL_MS, hashToken } from "@/server/auth/session";

function fakeDb(row: { lastActivityAt: Date | null; createdAt: Date }) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findUnique = vi.fn(async () => ({ id: "s1", userId: "u1", tokenHash: hashToken("tok"), revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000), reauthScope: null, reauthExpiresAt: null, ...row }));
  return { db: { session: { updateMany, findUnique } } as never, updateMany };
}

describe("kitchen board session activity", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("writes nothing while the session's activity is less than a minute old", async () => {
    const { db, updateMany } = fakeDb({ lastActivityAt: new Date(now.getTime() - 5_000), createdAt: new Date(now.getTime() - 600_000) });
    await recordSessionActivity(db, { id: "s1", lastActivityAt: new Date(now.getTime() - 5_000) }, now);
    await recordSessionActivity(db, { id: "s1", lastActivityAt: new Date(now.getTime() - (ACTIVITY_WRITE_INTERVAL_MS - 1)) }, now);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("slides the idle window once the last persisted activity is a minute old, or unknown", async () => {
    const { db, updateMany } = fakeDb({ lastActivityAt: null, createdAt: now });
    await recordSessionActivity(db, { id: "s1", lastActivityAt: new Date(now.getTime() - ACTIVITY_WRITE_INTERVAL_MS) }, now);
    await recordSessionActivity(db, { id: "s1" }, now);
    expect(updateMany).toHaveBeenCalledTimes(2);
    // The write itself stays conditional, so two racing polls still persist at most once.
    expect(updateMany.mock.calls[0]).toEqual([expect.objectContaining({ where: expect.objectContaining({ id: "s1", revokedAt: null, OR: [{ lastActivityAt: null }, { lastActivityAt: { lte: new Date(now.getTime() - ACTIVITY_WRITE_INTERVAL_MS) } }] }) })]);
  });

  it("validation reports the persisted activity time the poll then relies on", async () => {
    const seen = new Date(now.getTime() - 20_000);
    const { db, updateMany } = fakeDb({ lastActivityAt: seen, createdAt: new Date(now.getTime() - 600_000) });
    const background = await validateSession(db, "tok", { activity: false, now });
    expect(background?.lastActivityAt?.getTime()).toBe(seen.getTime());
    await recordSessionActivity(db, background!, now);
    expect(updateMany).not.toHaveBeenCalled();

    const stale = fakeDb({ lastActivityAt: new Date(now.getTime() - 120_000), createdAt: new Date(now.getTime() - 600_000) });
    const active = await validateSession(stale.db, "tok", { activity: true, now });
    expect(active?.lastActivityAt?.getTime()).toBe(now.getTime()); // just written by validation
    await recordSessionActivity(stale.db, active!, now);
    expect(stale.updateMany).toHaveBeenCalledTimes(1); // validation's write only, no second one
  });
});
