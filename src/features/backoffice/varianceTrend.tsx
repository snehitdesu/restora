"use client";

/**
 * Stock count variance over time (audit IN-09, proposal p. 6: "variance trends over time tell you whether the leak is
 * closing"). One pair of bars per approved count (loss and surplus found), oldest first, and a sentence that answers the
 * question in words. The report table below it is the same data; the chart is an addition, not a replacement.
 */
import { formatMoney } from "@/lib/format";

export type VarianceRow = { number: string; approvedAt: string; department?: string; loss: number; surplus: number; net: number };

export type TrendVerdict = "CLOSING" | "WIDENING" | "STEADY" | "TOO_FEW";
export type TrendSummary = { verdict: TrendVerdict; text: string; first: number; last: number; counts: number };

/** Oldest first, by when the count was approved. */
export const byApproval = (rows: VarianceRow[]) => [...rows].sort((a, b) => a.approvedAt.localeCompare(b.approvedAt) || a.number.localeCompare(b.number));

/**
 * Compare the loss found in the earlier half of the counts with the later half (averages, so one odd count does not
 * decide it). A change smaller than 10% of the earlier average, or under ₹1, is "steady".
 */
export function summarizeTrend(rows: VarianceRow[]): TrendSummary {
  const sorted = byApproval(rows);
  const n = sorted.length;
  if (n < 2) return { verdict: "TOO_FEW", text: n === 0 ? "No approved counts in this period." : "One count so far: a trend needs at least two.", first: sorted[0]?.loss ?? 0, last: sorted[0]?.loss ?? 0, counts: n };
  const half = Math.floor(n / 2);
  const avg = (xs: VarianceRow[]) => xs.reduce((a, r) => a + r.loss, 0) / xs.length;
  const earlier = avg(sorted.slice(0, half));
  const later = avg(sorted.slice(n - half));
  const change = later - earlier;
  const steady = Math.abs(change) < Math.max(1, earlier * 0.1);
  if (steady) return { verdict: "STEADY", text: `Loss per count is steady at about ${formatMoney(later)} across ${n} counts.`, first: earlier, last: later, counts: n };
  return change < 0
    ? { verdict: "CLOSING", text: `The leak is closing: loss per count fell from about ${formatMoney(earlier)} to ${formatMoney(later)} across ${n} counts.`, first: earlier, last: later, counts: n }
    : { verdict: "WIDENING", text: `The leak is widening: loss per count rose from about ${formatMoney(earlier)} to ${formatMoney(later)} across ${n} counts.`, first: earlier, last: later, counts: n };
}

const W = 640;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 34, left: 52 };

export function VarianceTrendChart({ rows }: { rows: VarianceRow[] }) {
  const data = byApproval(rows);
  const summary = summarizeTrend(rows);
  if (!data.length) return null;
  const max = Math.max(1, ...data.flatMap((r) => [r.loss, r.surplus]));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / data.length;
  const bar = Math.max(3, Math.min(22, slot / 2.6));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const tone = summary.verdict === "CLOSING" ? "text-ok-700" : summary.verdict === "WIDENING" ? "text-bad-600" : "text-ink-700";
  const every = Math.ceil(data.length / 12); // label at most ~12 counts
  return (
    <figure className="mb-4 rounded-xl border border-ink-200 bg-paper p-3 shadow-card" data-testid="variance-trend">
      <figcaption className={`mb-2 text-sm font-semibold ${tone}`} data-testid="variance-trend-summary">{summary.text}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Loss and surplus found at each of ${data.length} stock counts, oldest first. ${summary.text}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="stroke-ink-200" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="fill-ink-500 text-[10px]">{formatMoney(Math.round(t))}</text>
          </g>
        ))}
        {data.map((r, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          return (
            <g key={`${r.number}-${r.approvedAt}`}>
              <title>{`${r.number}${r.department ? ` · ${r.department}` : ""}: loss ${formatMoney(r.loss)}, surplus ${formatMoney(r.surplus)}`}</title>
              <rect x={cx - bar - 1} y={y(r.loss)} width={bar} height={Math.max(0, PAD.top + innerH - y(r.loss))} className="fill-bad-500" rx={2} />
              <rect x={cx + 1} y={y(r.surplus)} width={bar} height={Math.max(0, PAD.top + innerH - y(r.surplus))} className="fill-ok-500" rx={2} />
              {i % every === 0 && <text x={cx} y={H - 14} textAnchor="middle" className="fill-ink-600 text-[10px]">{r.number}</text>}
            </g>
          );
        })}
      </svg>
      <p className="mt-1 flex gap-4 text-xs text-ink-600" aria-hidden>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-bad-500" /> Loss found</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-ok-500" /> Surplus found</span>
      </p>
    </figure>
  );
}
