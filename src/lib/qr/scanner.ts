/**
 * Browser plumbing for the staff QR scanner: camera access, frame/image
 * decoding and duplicate suppression. Framework-free so it can be tested with
 * mocked hardware (tests/ui/table-qr-scanner.test.tsx).
 *
 * Decoding prefers the browser's native BarcodeDetector (Chrome/Edge/Android)
 * and falls back to jsQR (Safari/iOS, Firefox), loaded only when needed.
 */

export type CameraProblem = "unsupported" | "insecure" | "blocked" | "denied" | "unavailable" | "busy" | "error";

export const CAMERA_MESSAGES: Record<CameraProblem, string> = {
  unsupported: "This browser cannot use a camera here. Upload a photo of the QR or paste its link instead.",
  insecure: "The camera only works on a secure (https) address. Open RESTORA over https, or upload a photo of the QR instead.",
  blocked: "The camera is switched off for this page load. Reload the scanner page to turn it on.",
  denied: "Camera permission was not granted. Allow camera access for this site in the browser's address bar (or reload this page), then press Start scanning again.",
  unavailable: "No camera was found on this device. Upload a photo of the QR or paste its link instead.",
  busy: "The camera is in use by another app or tab. Close it there, then press Start scanning again.",
  error: "The camera could not be started. Try again, or upload a photo of the QR instead.",
};

type MediaLike = Pick<MediaDevices, "getUserMedia">;

/** Why the camera cannot be used before asking (null: go ahead and ask). */
export function cameraSupportProblem(env: { isSecureContext?: boolean; mediaDevices?: Partial<MediaLike> | undefined; policyAllowsCamera?: boolean | null } = globalThis as never): CameraProblem | null {
  if (env.isSecureContext === false) return "insecure";
  if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== "function") return "unsupported";
  if (env.policyAllowsCamera === false) return "blocked";
  return null;
}

type PolicyLike = { allowsFeature?: (feature: string) => boolean };

/**
 * Whether this document's Permissions-Policy allows the camera: false when the
 * page was reached by a client-side navigation from a page that forbids it.
 * null when the browser cannot say (Safari, Firefox) — then getUserMedia decides.
 */
export function documentAllowsCamera(doc: unknown = typeof document === "undefined" ? undefined : document): boolean | null {
  const d = doc as { permissionsPolicy?: PolicyLike; featurePolicy?: PolicyLike } | undefined;
  const policy = d?.permissionsPolicy ?? d?.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== "function") return null;
  try {
    return policy.allowsFeature("camera");
  } catch {
    return null;
  }
}

/** Map a getUserMedia failure to what the person can do about it. */
export function classifyCameraError(e: unknown): CameraProblem {
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "unavailable";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  if (name === "TypeError") return "unsupported";
  return "error";
}

/** The rear camera when the device has one (`ideal`, so laptops with one webcam still work). Video only. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
};

export async function openCamera(media: MediaLike): Promise<MediaStream> {
  return media.getUserMedia(CAMERA_CONSTRAINTS);
}

/** Stop every track of a stream (the camera light goes off). Safe to call twice or with null. */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }
}

/**
 * Duplicate suppression: the same text is accepted once per `cooldownMs`, and
 * nothing is accepted while a check is in flight (`busy`). A QR held in front
 * of the camera is therefore checked once, not every frame.
 */
export function createScanGate(cooldownMs = 3000) {
  let last: { text: string; at: number } | null = null;
  let busy = false;
  return {
    accept(text: string, now = Date.now()): boolean {
      if (busy) return false;
      if (last && last.text === text && now - last.at < cooldownMs) return false;
      last = { text, at: now };
      return true;
    },
    setBusy(v: boolean) {
      busy = v;
    },
    /** "Scan another": the next sighting of any code counts again. */
    reset() {
      last = null;
      busy = false;
    },
  };
}

// ---------------- decoding ----------------

type Drawable = CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
export type QrDecoder = { kind: "native" | "jsqr"; decode(source: Drawable, opts?: { thorough?: boolean }): Promise<string | null> };

type NativeDetector = { detect(source: unknown): Promise<Array<{ rawValue?: string }>> };
type NativeDetectorCtor = { new (opts: { formats: string[] }): NativeDetector; getSupportedFormats?: () => Promise<string[]> };

/** Longest side a frame is scaled to before jsQR (decoding cost grows with pixels). */
const MAX_DECODE_SIDE = 1280;

function sizeOf(source: Drawable): { w: number; h: number } {
  return { w: source.videoWidth || source.width || 0, h: source.videoHeight || source.height || 0 };
}

async function nativeDecoder(): Promise<QrDecoder | null> {
  const Ctor = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? ["qr_code"];
    if (!formats.includes("qr_code")) return null;
    const detector = new Ctor({ formats: ["qr_code"] });
    return {
      kind: "native",
      async decode(source) {
        const found = await detector.detect(source);
        return found.find((b) => typeof b.rawValue === "string" && b.rawValue)?.rawValue ?? null;
      },
    };
  } catch {
    return null;
  }
}

async function jsqrDecoder(): Promise<QrDecoder> {
  const { default: jsQR } = await import("jsqr");
  let canvas: HTMLCanvasElement | null = null;
  return {
    kind: "jsqr",
    async decode(source, opts) {
      const { w, h } = sizeOf(source);
      if (!w || !h) return null;
      const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      canvas ??= document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const g = canvas.getContext("2d", { willReadFrequently: true });
      if (!g) return null;
      g.drawImage(source, 0, 0, cw, ch);
      const img = g.getImageData(0, 0, cw, ch);
      return jsQR(img.data, cw, ch, { inversionAttempts: opts?.thorough ? "attemptBoth" : "dontInvert" })?.data || null;
    },
  };
}

/** The best decoder this browser offers. */
export async function createQrDecoder(): Promise<QrDecoder> {
  return (await nativeDecoder()) ?? jsqrDecoder();
}

// ---------------- image upload ----------------

export type ImageProblem = "not_image" | "too_large" | "unreadable" | "no_qr";
export const IMAGE_MESSAGES: Record<ImageProblem, string> = {
  not_image: "That file is not an image. Choose a photo or screenshot of the QR code.",
  too_large: "That image is too large (over 15 MB). Choose a smaller photo or a screenshot.",
  unreadable: "That image could not be opened. Try a PNG or JPEG photo or screenshot.",
  no_qr: "No QR code was found in that image. Make sure the whole code is in frame, sharp and well lit.",
};
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export class ImageScanError extends Error {
  constructor(readonly problem: ImageProblem) {
    super(IMAGE_MESSAGES[problem]);
  }
}

async function loadImage(file: Blob): Promise<Drawable & { close?: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to <img> (some browsers cannot bitmap every format)
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The text of the QR code in an uploaded image. Throws ImageScanError with a person-readable reason. */
export async function decodeQrImageFile(file: File, decoder: QrDecoder): Promise<string> {
  if (!file.type.startsWith("image/")) throw new ImageScanError("not_image");
  if (file.size > MAX_IMAGE_BYTES) throw new ImageScanError("too_large");
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(file);
  } catch {
    throw new ImageScanError("unreadable");
  }
  try {
    const text = await decoder.decode(image, { thorough: true });
    if (!text) throw new ImageScanError("no_qr");
    return text;
  } catch (e) {
    if (e instanceof ImageScanError) throw e;
    throw new ImageScanError("unreadable");
  } finally {
    image.close?.();
  }
}
