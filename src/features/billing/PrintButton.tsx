"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Browser print (or "Save as PDF") of the current bill page. Browsers do not
 * tell a page whether the dialog was cancelled or the printer failed, so the
 * status never claims "printed": it says what is known.
 */
export function PrintButton({ label = "Print" }: { label?: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const print = () => {
    setMsg(null);
    try {
      window.print();
      setMsg("Print dialog closed. If nothing came out (cancelled, or the printer is off or out of paper), check the printer and print again: reprinting never charges or re-sends the order.");
    } catch {
      setMsg("This browser could not open its print dialog. Use the browser menu's Print, or Send to printer if a receipt printer is set up.");
    }
  };
  return (
    <span className="inline-flex flex-col items-end gap-1 print:hidden">
      <Button variant="primary" onClick={print} data-autofocus>
        {label}
      </Button>
      {msg && <span role="status" className="max-w-xs text-right text-xs text-ink-600">{msg}</span>}
    </span>
  );
}
