"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { BACKGROUND_HEADER } from "@/constants/auth";
import { createPoller } from "@/lib/polling";

type SyncStatus = { state: "UNLINKED" | "ONLINE" | "OFFLINE" | "AUTH_REQUIRED"; pendingOps: number; conflictOps: number; staleSeconds: number | null };

const LABEL: Record<SyncStatus["state"], string> = {
  UNLINKED: "Cloud not linked",
  ONLINE: "Cloud online",
  OFFLINE: "Cloud offline",
  AUTH_REQUIRED: "Cloud sign-in needed",
};

/** Desktop POS only: whether the local cache is in step with the hosted restaurant. */
export function CloudSyncBadge() {
  const [st, setSt] = useState<SyncStatus | null>(null);
  useEffect(() => {
    const p = createPoller<SyncStatus>({
      intervalMs: 8_000,
      fetch: (signal) => api<SyncStatus>("/api/cloud/status", { signal, headers: { [BACKGROUND_HEADER]: "1" } }),
      onData: setSt,
    });
    p.start();
    return () => p.stop();
  }, []);
  if (!st || st.state === "UNLINKED") return null;
  const tone = st.state === "ONLINE" ? "text-vanilla-200" : "text-warn-200";
  const extra = st.state === "ONLINE" && st.pendingOps ? ` · ${st.pendingOps} queued` : st.conflictOps ? ` · ${st.conflictOps} conflict` : st.state === "OFFLINE" && st.staleSeconds != null ? ` · ${Math.max(1, Math.round(st.staleSeconds / 60))}m ago` : "";
  return (
    <Link href="/settings/cloud-sync" className={`hidden rounded-md px-2 py-1 text-xs font-medium hover:bg-white/10 sm:inline ${tone}`} title={LABEL[st.state]}>
      {LABEL[st.state]}{extra}
    </Link>
  );
}
