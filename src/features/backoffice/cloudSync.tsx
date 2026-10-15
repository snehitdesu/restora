"use client";

import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, FormDialog, Input, Select } from "@/components/ui/Form";
import { Card, PageHeader } from "@/components/ui/Page";
import { DataTable } from "@/components/ui/Table";
import { ActionButton } from "@/components/ui/Confirm";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

type SyncStatus = {
  state: "UNLINKED" | "ONLINE" | "OFFLINE" | "AUTH_REQUIRED";
  baseUrl: string | null;
  cloudOutletCode: string | null;
  userEmail: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  staleSeconds: number | null;
  pendingOps: number;
  conflictOps: number;
  ordersWithIssues: number;
};
type Pairing = { code: string; expiresAt: string; outletId: string; outletCode: string };
type Device = { id: string; name: string; outletId: string; outletCode: string; enrolledByEmail: string; status: string; lastSeenAt: string | null; expiresAt: string; createdAt: string };
type Op = { id: string; localOrderId: string; action: string; status: string; outcome: string | null; detail: string | null; attempts: number; createdAt: string; ref: string };

const STATE_TONE: Record<SyncStatus["state"], "ok" | "warn" | "bad" | "neutral"> = {
  UNLINKED: "neutral",
  ONLINE: "ok",
  OFFLINE: "warn",
  AUTH_REQUIRED: "bad",
};

export function CloudSyncScreen() {
  const { desktop } = useShell();
  return desktop ? <DesktopLinkPanel /> : <HostedPairingPanel />;
}

function HostedPairingPanel() {
  const { outlets, outletId } = useShell();
  const toast = useToast();
  const devices = useQuery<Device[]>("/api/sync/devices");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState(outletId ?? "");
  const generate = async () => {
    setBusy(true);
    try {
      setPairing(await api<Pairing>("/api/sync/pair", { method: "POST", body: { outletId: chosen } }));
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Could not create a pairing code", "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Cloud sync" subtitle="Pair an installed desktop POS with this outlet. The code works once, for ten minutes, and is tied to your account." />
      <Card title="Pair a desktop">
        <p className="mb-3 text-sm text-ink-600">On the desktop, open Cloud sync and enter this restaurant&apos;s address plus the code. Do not read the code into chat, email or a ticket.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Outlet" name="outletId">
            <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              {outlets.map((o) => (
                <option key={o.id} value={o.id}>{o.code} · {o.name}</option>
              ))}
            </Select>
          </Field>
          <Button onClick={() => void generate()} disabled={busy || !chosen}>{busy ? "Creating…" : "Create pairing code"}</Button>
        </div>
        {pairing && (
          <p className="mt-4 font-mono text-2xl tracking-[0.35em] text-ink-900" aria-label="Pairing code">
            {pairing.code.slice(0, 4)} {pairing.code.slice(4)}
          </p>
        )}
        {pairing && <p className="mt-1 text-sm text-ink-500">Expires {formatDateTime(pairing.expiresAt)} · outlet {pairing.outletCode}</p>}
      </Card>
      <Card title="Linked desktops" className="mt-4">
        {devices.error ? <ErrorState error={devices.error} onRetry={devices.reload} compact /> : devices.loading && !devices.data ? <LoadingState /> : (
          <DataTable
            label="Linked desktops"
            rows={devices.data ?? []}
            rowKey={(r) => r.id}
            empty="No desktop is linked yet"
            columns={[
              { key: "n", header: "Name", cell: (r) => r.name },
              { key: "o", header: "Outlet", cell: (r) => r.outletCode },
              { key: "w", header: "Paired by", cell: (r) => r.enrolledByEmail },
              { key: "s", header: "Status", cell: (r) => <Badge tone={r.status === "ACTIVE" ? "ok" : "neutral"}>{r.status}</Badge> },
              { key: "l", header: "Last seen", cell: (r) => (r.lastSeenAt ? formatDateTime(r.lastSeenAt) : "Never") },
              { key: "a", header: "", cell: (r) => r.status === "ACTIVE" ? (
                <ActionButton size="sm" variant="danger" action={() => api(`/api/sync/devices/${r.id}/revoke`, { method: "POST", body: {} })} confirm={{ title: "Revoke this desktop?", message: "It will stop receiving online orders until it is paired again.", danger: true, confirmLabel: "Revoke" }} onDone={devices.reload}>Revoke</ActionButton>
              ) : null },
            ]}
          />
        )}
      </Card>
    </>
  );
}

function DesktopLinkPanel() {
  const { outlets, outletId } = useShell();
  const status = useQuery<SyncStatus>("/api/cloud/status");
  const ops = useQuery<Op[]>("/api/cloud/operations", { attention: "1" });
  const [open, setOpen] = useState(false);
  const st = status.data;
  return (
    <>
      <PageHeader
        title="Cloud sync"
        subtitle="This computer mirrors online QR orders from the hosted restaurant. The cloud remains the source of truth."
        badge={st ? <Badge tone={STATE_TONE[st.state]}>{st.state.replace("_", " ")}</Badge> : undefined}
        actions={<Button onClick={() => setOpen(true)}>{st && st.state !== "UNLINKED" ? "Re-pair" : "Link to cloud"}</Button>}
      />
      {status.error ? <ErrorState error={status.error} onRetry={status.reload} /> : !st ? <LoadingState /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Link">
            {st.state === "UNLINKED" ? (
              <p className="text-sm text-ink-600">Not linked. Create a pairing code on the hosted POS (Settings → Cloud sync), or sign in with a manager account once.</p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-ink-500">Cloud</dt><dd>{st.baseUrl}</dd>
                <dt className="text-ink-500">Outlet</dt><dd>{st.cloudOutletCode}</dd>
                <dt className="text-ink-500">Account</dt><dd>{st.userEmail}</dd>
                <dt className="text-ink-500">Last success</dt><dd>{st.lastSuccessAt ? formatDateTime(st.lastSuccessAt) : "Never"}</dd>
                <dt className="text-ink-500">Cache age</dt><dd>{st.staleSeconds == null ? "—" : st.staleSeconds < 60 ? `${st.staleSeconds}s` : `${Math.round(st.staleSeconds / 60)} min`}</dd>
                {st.lastError && <><dt className="text-ink-500">Last error</dt><dd className="text-bad-700">{st.lastError}</dd></>}
              </dl>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {st.state !== "UNLINKED" && <Button onClick={() => void api("/api/cloud/sync", { method: "POST", body: {} }).then(() => { status.reload(); ops.reload(); })}>Sync now</Button>}
              {st.state !== "UNLINKED" && (
                <ActionButton variant="danger" action={() => api("/api/cloud/disconnect", { method: "POST", body: { discardPending: st.pendingOps > 0 } })}
                  confirm={{ title: "Disconnect from the cloud?", message: st.pendingOps ? `${st.pendingOps} action(s) have not reached the cloud. Disconnecting discards them.` : "This computer will stop mirroring online orders.", danger: true, confirmLabel: "Disconnect" }}
                  onDone={() => { status.reload(); ops.reload(); }}>Disconnect</ActionButton>
              )}
            </div>
          </Card>
          <Card title="Queue">
            <p className="mb-2 text-sm text-ink-600">{st.pendingOps} waiting · {st.conflictOps} need attention · {st.ordersWithIssues} order(s) with menu/floor mismatches</p>
            <DataTable
              label="Actions needing attention"
              rows={ops.data ?? []}
              rowKey={(r) => r.id}
              empty="Nothing waiting"
              columns={[
                { key: "r", header: "Order", cell: (r) => `#${r.ref}` },
                { key: "a", header: "Action", cell: (r) => r.action },
                { key: "s", header: "Status", cell: (r) => r.status },
                { key: "d", header: "Detail", cell: (r) => r.detail ?? r.outcome ?? "—" },
                { key: "x", header: "", cell: (r) => (r.status === "CONFLICT" || r.status === "REJECTED") ? (
                  <ActionButton size="sm" action={() => api(`/api/cloud/operations/${r.id}/dismiss`, { method: "POST", body: {} })} confirm={{ title: "Dismiss this action?", message: "The cloud's state is already mirrored." }} onDone={() => { ops.reload(); status.reload(); }}>Dismiss</ActionButton>
                ) : null },
              ]}
            />
          </Card>
        </div>
      )}
      {open && <ConnectDialog outlets={outlets} outletId={outletId} onClose={() => setOpen(false)} onDone={() => { setOpen(false); status.reload(); ops.reload(); }} />}
    </>
  );
}

function ConnectDialog({ outlets, outletId, onClose, onDone }: { outlets: Array<{ id: string; code: string; name: string }>; outletId: string | null; onClose: () => void; onDone: () => void }) {
  const local = outlets.find((o) => o.id === outletId);
  const [baseUrl, setBaseUrl] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localOutletCode, setLocalOutletCode] = useState(local?.code ?? "");
  const [cloudOutletCode, setCloudOutletCode] = useState("");
  const [mode, setMode] = useState<"code" | "password">("code");
  return (
    <FormDialog open onClose={onClose} title="Link to the hosted restaurant" submitLabel="Link" size="md"
      description="The pairing code or password is sent once and is not stored. The device credential is encrypted with this computer's operating-system key store."
      onSubmit={() => api("/api/cloud/connect", {
        method: "POST",
        body: mode === "code"
          ? { baseUrl, pairingCode: pairingCode.replace(/\s/g, ""), localOutletCode }
          : { baseUrl, email, password, localOutletCode, cloudOutletCode: cloudOutletCode || undefined },
      })}
      onDone={onDone}>
      <Field label="Cloud address" name="baseUrl" required hint="https://your-restaurant.example.com">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} autoComplete="off" />
      </Field>
      <div className="mb-3 flex gap-2">
        <Button type="button" size="sm" onClick={() => setMode("code")} className={mode === "code" ? undefined : "opacity-70"}>Pairing code</Button>
        <Button type="button" size="sm" onClick={() => setMode("password")} className={mode === "password" ? undefined : "opacity-70"}>Manager sign-in</Button>
      </div>
      {mode === "code" ? (
        <Field label="Pairing code" name="pairingCode" required>
          <Input value={pairingCode} onChange={(e) => setPairingCode(e.target.value.toUpperCase())} autoComplete="one-time-code" className="font-mono tracking-widest" />
        </Field>
      ) : (
        <>
          <Field label="Cloud email" name="email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
          <Field label="Password" name="password" required><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
          <Field label="Cloud outlet code" name="cloudOutletCode" hint="Required if that account can see more than one outlet">
            <Input value={cloudOutletCode} onChange={(e) => setCloudOutletCode(e.target.value)} />
          </Field>
        </>
      )}
      <Field label="Outlet on this computer" name="localOutletCode">
        <Select value={localOutletCode} onChange={(e) => setLocalOutletCode(e.target.value)}>
          {outlets.map((o) => <option key={o.id} value={o.code}>{o.code} · {o.name}</option>)}
        </Select>
      </Field>
    </FormDialog>
  );
}
