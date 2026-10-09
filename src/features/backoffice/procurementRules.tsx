"use client";

/**
 * Purchase order approval rules (audit PP-07): the small-order limit below which an order approves itself, and the large-order
 * limit from which it needs two different approvers. Both optional; empty means "off". Changing them asks for the owner's
 * password again, and every change is audited (before and after) on the server.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { formatMoney } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Card, PageHeader } from "@/components/ui/Page";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { Field, FormAlert, FormErrors, Input, useSubmit } from "@/components/ui/Form";

type Rules = { autoApproveBelow: number | null; dualApprovalAtOrAbove: number | null };

const toNumber = (v: string): number | null | "bad" => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && Math.round(n * 100) === n * 100 ? n : "bad";
};

export function PurchasingRulesScreen() {
  const toast = useToast();
  const q = useQuery<Rules>("/api/procurement/rules");
  const form = useSubmit();
  const [auto, setAuto] = useState("");
  const [dual, setDual] = useState("");
  useEffect(() => {
    if (q.data) {
      setAuto(q.data.autoApproveBelow === null ? "" : String(q.data.autoApproveBelow));
      setDual(q.data.dualApprovalAtOrAbove === null ? "" : String(q.data.dualApprovalAtOrAbove));
    }
  }, [q.data]);
  if (q.error) return <><PageHeader title="Purchasing rules" /><ErrorState error={q.error} onRetry={q.reload} /></>;
  if (!q.data) return <LoadingState />;

  const a = toNumber(auto);
  const d = toNumber(dual);
  const invalid = a === "bad" || d === "bad" || (typeof a === "number" && typeof d === "number" && a >= d);
  const dirty = a !== q.data.autoApproveBelow || d !== q.data.dualApprovalAtOrAbove;
  async function save() {
    if (a === "bad" || d === "bad") return;
    const r = await form.submit(() => api<Rules>("/api/procurement/rules", { method: "POST", body: { autoApproveBelow: a, dualApprovalAtOrAbove: d } }));
    if (r.ok) { toast.show("Purchasing rules saved", "ok"); q.reload(); }
  }
  return (
    <>
      <PageHeader title="Purchasing rules" subtitle="Who has to approve a purchase order, by its size" />
      <Card className="max-w-2xl">
        <FormAlert message={form.message} />
        <FormErrors errors={form.errors}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Approve small orders automatically up to" name="autoApproveBelow" hint="At or below this total, an order approves itself when it is submitted. Leave empty to approve every order by hand.">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={auto} onChange={(e) => setAuto(e.target.value)} placeholder="Off" />
          </Field>
          <Field label="Need two approvers from" name="dualApprovalAtOrAbove" hint="At or above this total, two different people with purchase approval must approve. Leave empty to need one approver always.">
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={dual} onChange={(e) => setDual(e.target.value)} placeholder="Off" />
          </Field>
        </div>
        </FormErrors>
        {typeof a === "number" && typeof d === "number" && a >= d && <p role="alert" className="mt-3 text-sm text-bad-700">Orders approved automatically must be smaller than the orders that need two approvers.</p>}
        <ul className="mt-4 space-y-1 text-sm text-ink-600" aria-label="What this means">
          <li>{typeof a === "number" ? `An order of ${formatMoney(a)} or less is approved the moment it is submitted: nobody has to approve it.` : "Every order waits for an approver."}</li>
          <li>{typeof d === "number" ? `An order of ${formatMoney(d)} or more needs two different approvers; the first approval is recorded and the second one completes it.` : "One approver is always enough."}</li>
          {typeof a === "number" && typeof d === "number" && a < d && <li>{`Orders in between (above ${formatMoney(a)}, below ${formatMoney(d)}) need one approver.`}</li>}
        </ul>
        <div className="mt-5 flex items-center gap-2">
          <Button variant="primary" onClick={() => void save()} loading={form.busy} disabled={invalid || !dirty}>Save rules</Button>
          {!dirty && <span className="text-xs text-ink-500">No changes</span>}
        </div>
        <p className="mt-3 text-xs text-ink-500">Saving asks for your password again. A rule applies from the next submission or approval; orders already approved are not changed.</p>
      </Card>
    </>
  );
}
