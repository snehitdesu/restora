"use client";

/**
 * Staff QR scanner (Floors & tables → Scan QR): point the camera at a table QR,
 * upload a photo of one, or paste its link, and see which table it opens and
 * whether it works on this deployment.
 *
 * The camera is requested only when "Start scanning" is pressed, and every
 * track is stopped on success, Stop, leaving the page, hiding the tab and
 * unmount. Scanned text is checked by POST /api/master/table-qr/scan (the guest
 * site's own lookup); this screen never opens the scanned URL — only the
 * validated guest link the server returns, and only when the person clicks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { Field, Input } from "@/components/ui/Form";
import { Card, PageHeader } from "@/components/ui/Page";
import { TABLE_QR_MESSAGES, guestTableUrl, parseTableQr, type TableQrRejection } from "@/lib/qr/tableQrUrl";
import {
  CAMERA_MESSAGES,
  ImageScanError,
  cameraSupportProblem,
  classifyCameraError,
  createQrDecoder,
  createScanGate,
  decodeQrImageFile,
  documentAllowsCamera,
  openCamera,
  stopStream,
  type CameraProblem,
  type QrDecoder,
} from "@/lib/qr/scanner";

// Mirrors server/qr/scan.ts QrScanResult (the API's JSON shape).
type Environment = { qrOrigin: string | null; appOrigin: string; matchesApp: boolean | null };
type TableFacts = { table: { code: string }; outletName: string; restaurantName: string; tokenHint: string; environment: Environment };
export type ScanResult =
  | ({ status: "valid"; guestUrl: string } & TableFacts)
  | ({ status: "inactive"; message: string } & TableFacts)
  | { status: "not_found"; tokenHint: string; environment: Environment; message: string }
  | { status: "rejected"; reason: TableQrRejection; message: string };

type CameraState = "idle" | "starting" | "scanning" | "stopped" | CameraProblem;
type Source = "camera" | "image" | "manual";
type Check = { phase: "checking"; source: Source } | { phase: "done"; source: Source; result: ScanResult } | { phase: "failed"; source: Source; message: string };

const FRAME_INTERVAL_MS = 150;

/** The guest link may be opened only if it is exactly a guest URL on the deployment's own origin. */
export function safeGuestLink(result: ScanResult): string | null {
  if (result.status !== "valid") return null;
  const parsed = parseTableQr(result.guestUrl, { trustedOrigins: [result.environment.appOrigin] });
  if (!parsed.ok || !parsed.origin) return null;
  const normalized = guestTableUrl(parsed.origin, parsed.token);
  return normalized === result.guestUrl ? normalized : null;
}

export function TableQrScannerScreen({ media }: { media?: Pick<MediaDevices, "getUserMedia"> } = {}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const decoderRef = useRef<Promise<QrDecoder> | null>(null);
  const gateRef = useRef(createScanGate());
  const runRef = useRef(0); // bumps on every start/stop: a stale async step never touches a newer camera
  const resultRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [camera, setCamera] = useState<CameraState>("idle");
  const [check, setCheck] = useState<Check | null>(null);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const decoder = useCallback(() => (decoderRef.current ??= createQrDecoder()), []);

  /** Stop the camera completely: loop, tracks, and the video element's reference to the stream. */
  const stopCamera = useCallback((next: CameraState = "stopped") => {
    runRef.current += 1;
    if (loopRef.current) clearTimeout(loopRef.current);
    loopRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
      } catch {
        // jsdom / already paused
      }
      v.srcObject = null;
    }
    setCamera((c) => (c === "idle" && next === "stopped" ? "idle" : next));
  }, []);

  /** Validate scanned or pasted text: a shape pre-check here, the real check on the server. */
  const submit = useCallback(async (text: string, source: Source) => {
    const gate = gateRef.current;
    if (!gate.accept(text)) return;
    gate.setBusy(true);
    try {
      const pre = parseTableQr(text);
      if (!pre.ok) {
        setCheck({ phase: "done", source, result: { status: "rejected", reason: pre.reason, message: pre.message } });
        return;
      }
      setCheck({ phase: "checking", source });
      const result = await api<ScanResult>("/api/master/table-qr/scan", { method: "POST", body: { text } });
      setCheck({ phase: "done", source, result });
    } catch (e) {
      setCheck({ phase: "failed", source, message: describeError(e) });
    } finally {
      gate.setBusy(false);
    }
  }, []);

  const startCamera = useCallback(async () => {
    setCheck(null);
    gateRef.current.reset();
    const problem = cameraSupportProblem({
      isSecureContext: media ? true : window.isSecureContext,
      mediaDevices: media ?? navigator.mediaDevices,
      policyAllowsCamera: documentAllowsCamera(),
    });
    if (problem) return setCamera(problem);
    stopCamera("starting");
    const run = runRef.current;
    let stream: MediaStream;
    try {
      stream = await openCamera(media ?? navigator.mediaDevices);
    } catch (e) {
      if (run === runRef.current) setCamera(classifyCameraError(e));
      return;
    }
    if (run !== runRef.current) return stopStream(stream); // stopped or unmounted while the prompt was open
    streamRef.current = stream;
    const v = videoRef.current;
    if (!v) return stopCamera("error");
    v.srcObject = stream;
    v.muted = true;
    v.setAttribute("playsinline", "true");
    try {
      await v.play();
    } catch {
      // autoplay of a muted inline video is allowed; a failure here still leaves frames available
    }
    if (run !== runRef.current) return;
    setCamera("scanning");
    let dec: QrDecoder;
    try {
      dec = await decoder();
    } catch {
      if (run === runRef.current) stopCamera("error");
      return;
    }
    const tick = async () => {
      if (run !== runRef.current) return;
      try {
        const ready = v.readyState >= 2 && v.videoWidth > 0;
        const text = ready ? await dec.decode(v) : null;
        if (run !== runRef.current) return;
        if (text) {
          stopCamera("stopped"); // success: the camera turns off before anything else happens
          await submit(text, "camera");
          return;
        }
      } catch {
        // a frame that fails to decode is just the next frame's problem
      }
      if (run === runRef.current) loopRef.current = setTimeout(tick, FRAME_INTERVAL_MS);
    };
    loopRef.current = setTimeout(tick, FRAME_INTERVAL_MS);
  }, [decoder, media, stopCamera, submit]);

  // Camera off when the tab is hidden, the page is left, or the screen unmounts.
  useEffect(() => {
    const onHide = () => {
      if (streamRef.current) stopCamera("stopped");
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      runRef.current += 1;
      if (loopRef.current) clearTimeout(loopRef.current);
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [stopCamera]);

  // Move focus to the outcome so keyboard and screen-reader users hear it.
  useEffect(() => {
    if (check?.phase === "done" || check?.phase === "failed") resultRef.current?.focus();
  }, [check]);

  const onFile = async (file: File | undefined) => {
    setImageError(null);
    if (!file) return;
    if (streamRef.current) stopCamera("stopped");
    gateRef.current.reset();
    try {
      const text = await decodeQrImageFile(file, await decoder());
      await submit(text, "image");
    } catch (e) {
      setImageError(e instanceof ImageScanError ? e.message : "That image could not be read. Try another photo or paste the link instead.");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onManual = async (e: React.FormEvent) => {
    e.preventDefault();
    setManualError(null);
    const pre = parseTableQr(manual);
    if (!pre.ok) {
      setManualError(pre.message);
      return;
    }
    gateRef.current.reset();
    await submit(manual.trim(), "manual");
  };

  /** Clear the outcome; the camera comes back on only if it was the camera that read the last code. */
  const scanAnother = () => {
    const restart = check?.source === "camera";
    setCheck(null);
    setManual("");
    setManualError(null);
    setImageError(null);
    gateRef.current.reset();
    if (restart) void startCamera();
  };

  const live = camera === "starting" || camera === "scanning";
  const problem = camera !== "idle" && camera !== "starting" && camera !== "scanning" && camera !== "stopped" ? (camera as CameraProblem) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Scan table QR"
        subtitle="Check which table a printed QR opens and whether it works on this RESTORA deployment."
        back={{ href: "/tables", label: "Floors & tables" }}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card title="Camera" bodyClassName="p-4 sm:p-5">
          <div className="relative mx-auto aspect-[4/3] w-full max-w-xl overflow-hidden rounded-lg border border-ink-200 bg-ink-900">
            <video ref={videoRef} className={`h-full w-full object-cover ${live ? "" : "hidden"}`} muted playsInline aria-label="Camera preview" data-testid="qr-video" />
            {live ? (
              <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="relative aspect-square w-3/5 max-w-[16rem] rounded-xl border-2 border-paper/90 shadow-[0_0_0_9999px_rgba(38,24,16,0.45)]">
                  <span className="absolute -left-0.5 -top-0.5 h-7 w-7 rounded-tl-xl border-l-4 border-t-4 border-brand-500" />
                  <span className="absolute -right-0.5 -top-0.5 h-7 w-7 rounded-tr-xl border-r-4 border-t-4 border-brand-500" />
                  <span className="absolute -bottom-0.5 -left-0.5 h-7 w-7 rounded-bl-xl border-b-4 border-l-4 border-brand-500" />
                  <span className="absolute -bottom-0.5 -right-0.5 h-7 w-7 rounded-br-xl border-b-4 border-r-4 border-brand-500" />
                </div>
              </div>
            ) : (
              <div className="absolute inset-0 grid place-items-center bg-paper-warm p-6 text-center">
                <div className="max-w-sm">
                  <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-brand-50 text-brand-600">
                    <Icon name="qr" className="h-7 w-7" />
                  </div>
                  <p className="text-sm text-ink-700">
                    {problem ? "The camera is not available right now." : "Press Start scanning, allow camera access when the browser asks, and hold the table QR inside the frame."}
                  </p>
                </div>
              </div>
            )}
          </div>

          <p role="status" aria-live="polite" className="mt-3 min-h-[1.25rem] text-center text-sm text-ink-700">
            {camera === "starting" && "Starting the camera… allow access if the browser asks."}
            {camera === "scanning" && "Scanning — hold the QR steady inside the frame."}
            {camera === "stopped" && !check && "Camera off."}
          </p>

          {problem && (
            <div role="alert" className="mt-2 rounded-md border border-warn-100 bg-warn-50 px-3 py-2 text-sm text-warn-700" data-testid="camera-problem" data-problem={problem}>
              {CAMERA_MESSAGES[problem]}
              {problem === "blocked" && (
                <Button size="sm" className="ml-2" onClick={() => window.location.reload()}>
                  Reload scanner
                </Button>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {live ? (
              <Button variant="secondary" onClick={() => stopCamera("stopped")}>
                Stop camera
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void startCamera()} disabled={check?.phase === "checking"}>
                <Icon name="qr" /> {camera === "idle" ? "Start scanning" : "Resume scanning"}
              </Button>
            )}
          </div>
          <p className="mt-3 text-center text-xs text-ink-500">The camera is used only on this screen and turns off as soon as a code is read.</p>
        </Card>

        <div className="space-y-5">
          <div ref={resultRef} tabIndex={-1} className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500" aria-live="polite">
            {check ? <Outcome check={check} onScanAnother={scanAnother} /> : <EmptyOutcome />}
          </div>

          <Card title="No camera? Other ways to check" bodyClassName="p-4 sm:p-5 space-y-5">
            <div>
              <p className="mb-2 text-sm font-semibold text-ink-900">Upload a photo of the QR</p>
              <input ref={fileRef} id="qr-image" type="file" accept="image/*" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
              <label htmlFor="qr-image" className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-ink-300 bg-paper px-3 py-2 text-sm font-semibold text-ink-900 hover:bg-ink-50 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-500">
                <Icon name="upload" /> Choose image
              </label>
              {imageError && <p role="alert" className="mt-2 text-sm text-bad-600">{imageError}</p>}
            </div>
            <form onSubmit={(e) => void onManual(e)} noValidate>
              <Field label="Or paste the QR link or table token" name="qr-manual" hint="For example https://your-restaurant.example/t/…">
                <Input
                  id="qr-manual"
                  name="qr-manual"
                  value={manual}
                  onChange={(e) => {
                    setManual(e.target.value);
                    setManualError(null);
                  }}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  inputMode="url"
                  maxLength={2048}
                  aria-invalid={manualError ? true : undefined}
                  aria-describedby={manualError ? "qr-manual-error" : undefined}
                />
              </Field>
              {manualError && <p id="qr-manual-error" role="alert" className="mt-1 text-sm text-bad-600">{manualError}</p>}
              <Button type="submit" variant="secondary" className="mt-3" disabled={!manual.trim() || check?.phase === "checking"}>
                Check link
              </Button>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}

function EmptyOutcome() {
  return (
    <section className="rounded-lg border border-dashed border-ink-300 bg-paper-warm px-5 py-6 text-sm text-ink-700">
      <h2 className="text-[1.02rem] font-semibold text-ink-900">No QR checked yet</h2>
      <p className="mt-1">Scan, upload or paste a table QR. You will see the table it opens, its restaurant, and whether guests can order from it here.</p>
    </section>
  );
}

const SOURCE_LABEL: Record<Source, string> = { camera: "camera", image: "uploaded image", manual: "pasted link" };

function Outcome({ check, onScanAnother }: { check: Check; onScanAnother: () => void }) {
  if (check.phase === "checking") {
    return (
      <section className="rounded-lg border border-ink-200 bg-paper px-5 py-6 shadow-card" aria-busy="true">
        <p className="text-sm text-ink-700">Checking the QR from the {SOURCE_LABEL[check.source]}…</p>
      </section>
    );
  }
  if (check.phase === "failed") {
    return (
      <OutcomeShell tone="warn" title="Could not check this QR" testId="scan-failed">
        <p>{check.message}</p>
        <Actions onScanAnother={onScanAnother} again="Try again" />
      </OutcomeShell>
    );
  }
  const r = check.result;
  if (r.status === "valid") {
    const link = safeGuestLink(r);
    return (
      <OutcomeShell tone="ok" title="Valid RESTORA table QR" testId="scan-valid" badge={<Badge tone="ok">Works here</Badge>}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="text-ink-500">Table</dt>
          <dd className="font-display text-2xl font-semibold leading-none text-ink-900" data-testid="scan-table">{r.table.code}</dd>
          <dt className="text-ink-500">Restaurant</dt>
          <dd className="text-ink-900">{r.restaurantName}</dd>
          <dt className="text-ink-500">Outlet</dt>
          <dd className="text-ink-900">{r.outletName}</dd>
          <dt className="text-ink-500">Code</dt>
          <dd className="font-mono text-ink-700">{r.tokenHint}</dd>
        </dl>
        <EnvironmentNote env={r.environment} />
        <div className="mt-4 flex flex-wrap gap-2">
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            >
              Open customer ordering page
            </a>
          ) : (
            <p className="text-sm text-bad-600">The ordering link could not be verified, so it is not offered.</p>
          )}
          <Button onClick={onScanAnother}>Scan another QR</Button>
        </div>
      </OutcomeShell>
    );
  }
  if (r.status === "inactive") {
    return (
      <OutcomeShell tone="warn" title={`Table ${r.table.code} — QR switched off`} testId="scan-inactive" badge={<Badge tone="warn">Inactive</Badge>}>
        <p>{r.message}</p>
        <p className="mt-2 text-ink-700">{r.restaurantName} · {r.outletName}</p>
        <EnvironmentNote env={r.environment} />
        <Actions onScanAnother={onScanAnother} again="Scan another QR" />
      </OutcomeShell>
    );
  }
  if (r.status === "not_found") {
    return (
      <OutcomeShell tone="bad" title="QR not recognised here" testId="scan-not-found" badge={<Badge tone="bad">Invalid</Badge>}>
        <p>{r.message}</p>
        <p className="mt-2 font-mono text-xs text-ink-500">Code {r.tokenHint}</p>
        <EnvironmentNote env={r.environment} />
        <Actions onScanAnother={onScanAnother} again="Try again" />
      </OutcomeShell>
    );
  }
  return (
    <OutcomeShell tone="bad" title="Not a RESTORA table QR" testId="scan-rejected" badge={<Badge tone="bad">Rejected</Badge>}>
      <p>{r.message || TABLE_QR_MESSAGES[r.reason]}</p>
      <p className="mt-2 text-ink-500">Nothing was opened. Only RESTORA table links for this deployment are accepted.</p>
      <Actions onScanAnother={onScanAnother} again="Try again" />
    </OutcomeShell>
  );
}

function EnvironmentNote({ env }: { env: Environment }) {
  if (env.matchesApp === null) {
    return <p className="mt-3 text-xs text-ink-500">Checked as a pasted table token against this deployment ({env.appOrigin}).</p>;
  }
  if (env.matchesApp) {
    return <p className="mt-3 text-xs text-ink-500">Printed for this deployment&apos;s guest address ({env.appOrigin}).</p>;
  }
  return (
    <p role="note" className="mt-3 rounded-md border border-warn-100 bg-warn-50 px-3 py-2 text-xs text-warn-700">
      This QR opens {env.qrOrigin}, but this deployment&apos;s guest address is {env.appOrigin}. It was checked against this deployment&apos;s tables; guests scanning it reach {env.qrOrigin}.
    </p>
  );
}

function Actions({ onScanAnother, again }: { onScanAnother: () => void; again: string }) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Button variant="primary" onClick={onScanAnother}>
        {again}
      </Button>
      <a href="#qr-manual" className="inline-flex items-center rounded-md px-3 py-2 text-sm font-semibold text-brand-700 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
        Enter the link manually
      </a>
    </div>
  );
}

const TONE = {
  ok: "border-ok-100 bg-ok-50/60",
  warn: "border-warn-100 bg-warn-50/60",
  bad: "border-bad-100 bg-bad-50/60",
} as const;

function OutcomeShell({ tone, title, badge, testId, children }: { tone: keyof typeof TONE; title: string; badge?: React.ReactNode; testId: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-lg border px-5 py-5 text-sm text-ink-900 shadow-card ${TONE[tone]}`} data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Icon name={tone === "ok" ? "check" : "alert"} className={`h-5 w-5 ${tone === "ok" ? "text-ok-600" : tone === "warn" ? "text-warn-600" : "text-bad-600"}`} />
        <h2 className="text-[1.05rem] font-semibold">{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  );
}
