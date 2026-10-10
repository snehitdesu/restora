"use client";

import { useMemo } from "react";
import { qrSvgPath } from "@/lib/qrSvg";

export { qrSvgPath, qrSvgDocument } from "@/lib/qrSvg";

/** Scannable QR code for `value`, drawn as SVG (no canvas, no injected markup). */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, d } = useMemo(() => qrSvgPath(value), [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className={className}>
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
