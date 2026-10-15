// @vitest-environment jsdom
/**
 * Staff QR scanner screen with mocked camera hardware (no physical camera):
 * the camera is requested only on Start, denial / no camera / no API each
 * explain themselves, every track stops on success, Stop, tab hide and
 * unmount, a code held in view is checked once, results never auto-open a
 * link, and the image + manual fallbacks work.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { state, installFetch, teardown } from "./harness";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const decodeMock = vi.fn<(source: unknown, opts?: { thorough?: boolean }) => Promise<string | null>>();
vi.mock("@/lib/qr/scanner", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/qr/scanner")>();
  return { ...real, createQrDecoder: vi.fn(async () => ({ kind: "jsqr" as const, decode: decodeMock })) };
});

import { TableQrScannerScreen, safeGuestLink, type ScanResult } from "@/features/backoffice/tableQrScanner";
import { ImageScanError, decodeQrImageFile, MAX_IMAGE_BYTES } from "@/lib/qr/scanner";

const APP = "http://localhost";
const TOKEN = "ccAbCdEfGh0123456789_-";
const QR = `${APP}/t/${TOKEN}`;
const VALID: ScanResult = {
  status: "valid", table: { code: "T01" }, outletName: "Coders' Cafe", restaurantName: "Coders' Cafe", tokenHint: "••••9_-",
  environment: { qrOrigin: APP, appOrigin: APP, matchesApp: true }, guestUrl: QR,
};

function fakeCamera() {
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  return { media: { getUserMedia }, tracks, getUserMedia };
}

beforeEach(() => {
  installFetch();
  state.routes = { "POST /api/master/table-qr/scan": () => VALID };
  decodeMock.mockReset();
  decodeMock.mockResolvedValue(null);
  // jsdom has no media pipeline: a "playing" video with frames.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 480 });
});
afterEach(() => {
  teardown();
  vi.restoreAllMocks();
});

const scans = () => state.calls.filter((c) => c.method === "POST" && c.path === "/api/master/table-qr/scan");

describe("camera permission and failure states", () => {
  it("opening the page does not ask for the camera; Start does, for the rear camera", async () => {
    const cam = fakeCamera();
    render(<TableQrScannerScreen media={cam.media} />);
    expect(cam.getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    await waitFor(() => expect(cam.getUserMedia).toHaveBeenCalledTimes(1));
    expect(cam.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false, video: expect.objectContaining({ facingMode: { ideal: "environment" } }) }));
    expect(await screen.findByText(/hold the qr steady/i)).toBeInTheDocument();
  });

  it.each([
    ["NotAllowedError", "denied", /permission was not granted/i],
    ["NotFoundError", "unavailable", /no camera was found/i],
    ["NotReadableError", "busy", /in use by another app/i],
  ])("%s → %s, with what to do next", async (name, problem, text) => {
    const getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("x"), { name });
    });
    render(<TableQrScannerScreen media={{ getUserMedia }} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    const alert = await screen.findByTestId("camera-problem");
    expect(alert).toHaveAttribute("data-problem", problem);
    expect(alert).toHaveTextContent(text);
    // The fallbacks stay available, and scanning can be retried.
    expect(screen.getByLabelText(/paste the qr link/i)).toBeEnabled();
    expect(screen.getByRole("button", { name: /resume scanning/i })).toBeEnabled();
  });

  it("a page load whose policy forbids the camera offers a reload instead of asking", async () => {
    const cam = fakeCamera();
    Object.defineProperty(document, "featurePolicy", { configurable: true, value: { allowsFeature: (f: string) => f !== "camera" } });
    try {
      render(<TableQrScannerScreen media={cam.media} />);
      fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
      expect(await screen.findByTestId("camera-problem")).toHaveAttribute("data-problem", "blocked");
      expect(screen.getByRole("button", { name: /reload scanner/i })).toBeInTheDocument();
      expect(cam.getUserMedia).not.toHaveBeenCalled();
    } finally {
      delete (document as { featurePolicy?: unknown }).featurePolicy;
    }
  });

  it("the Floors & tables screen enters the scanner with a full page load (the camera policy is per page load)", () => {
    const src = readFileSync(path.join(process.cwd(), "src", "features", "backoffice", "tables.tsx"), "utf8");
    expect(src).toMatch(/<a href="\/tables\/scan"/);
    expect(src).not.toMatch(/<Link href="\/tables\/scan"/);
  });

  it("a browser without a camera API says so instead of crashing", async () => {
    render(<TableQrScannerScreen media={{} as Pick<MediaDevices, "getUserMedia">} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    expect(await screen.findByTestId("camera-problem")).toHaveAttribute("data-problem", "unsupported");
  });
});

describe("camera cleanup", () => {
  it("Stop turns every track off", async () => {
    const cam = fakeCamera();
    render(<TableQrScannerScreen media={cam.media} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop camera/i }));
    expect(cam.tracks[0].stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /resume scanning/i })).toBeInTheDocument();
  });

  it("leaving the screen (unmount) turns the camera off", async () => {
    const cam = fakeCamera();
    const view = render(<TableQrScannerScreen media={cam.media} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    await screen.findByRole("button", { name: /stop camera/i });
    view.unmount();
    expect(cam.tracks[0].stop).toHaveBeenCalled();
  });

  it("hiding the tab turns the camera off", async () => {
    const cam = fakeCamera();
    render(<TableQrScannerScreen media={cam.media} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    await screen.findByRole("button", { name: /stop camera/i });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    expect(cam.tracks[0].stop).toHaveBeenCalled();
  });

  it("a stream granted after Stop was pressed is stopped at once", async () => {
    let grant!: (s: MediaStream) => void;
    const tracks = [{ stop: vi.fn() }];
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((r) => (grant = r)));
    render(<TableQrScannerScreen media={{ getUserMedia }} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop camera/i }));
    await act(async () => grant({ getTracks: () => tracks } as unknown as MediaStream));
    expect(tracks[0].stop).toHaveBeenCalled();
  });
});

describe("a successful camera scan", () => {
  it("stops the camera, checks the code once even while it stays in view, and never opens it by itself", async () => {
    const cam = fakeCamera();
    decodeMock.mockResolvedValue(QR); // the same code on every frame
    const assign = vi.fn();
    vi.stubGlobal("open", assign);
    render(<TableQrScannerScreen media={cam.media} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    expect(await screen.findByTestId("scan-valid")).toBeInTheDocument();
    expect(cam.tracks[0].stop).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 400)); // several frame intervals
    expect(scans()).toHaveLength(1);
    expect(scans()[0].body).toEqual({ text: QR });
    expect(assign).not.toHaveBeenCalled();

    expect(screen.getByTestId("scan-table")).toHaveTextContent("T01");
    expect(screen.getAllByText("Coders' Cafe").length).toBeGreaterThan(0);
    expect(screen.queryByText(new RegExp(TOKEN))).toBeNull(); // the full token is not displayed
    const open = screen.getByRole("link", { name: /open customer ordering page/i });
    expect(open).toHaveAttribute("href", QR);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", expect.stringContaining("noopener"));

    // "Scan another" asks for the camera again (a person's click).
    fireEvent.click(screen.getByRole("button", { name: /scan another qr/i }));
    await waitFor(() => expect(cam.getUserMedia).toHaveBeenCalledTimes(2));
  });

  it("an unsafe code is rejected on the device without a server call", async () => {
    const cam = fakeCamera();
    decodeMock.mockResolvedValue("javascript:alert(1)");
    render(<TableQrScannerScreen media={cam.media} />);
    fireEvent.click(screen.getByRole("button", { name: /start scanning/i }));
    expect(await screen.findByTestId("scan-rejected")).toHaveTextContent(/only http and https/i);
    expect(scans()).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /open customer ordering page/i })).toBeNull();
  });
});

describe("results from the server", () => {
  async function paste(text: string) {
    render(<TableQrScannerScreen media={fakeCamera().media} />);
    fireEvent.change(screen.getByLabelText(/paste the qr link/i), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: /check link/i }));
  }

  it("manual input: a malformed token is explained without calling the server", async () => {
    await paste("abc");
    expect(await screen.findByRole("alert")).toHaveTextContent(/not in RESTORA's format/i);
    expect(scans()).toHaveLength(0);
  });

  it("manual input: a valid link is checked on the server", async () => {
    await paste(`  ${QR}  `);
    expect(await screen.findByTestId("scan-valid")).toBeInTheDocument();
    expect(scans()[0].body).toEqual({ text: QR });
  });

  it("inactive and unknown tables are distinguished, with Try again and manual entry", async () => {
    state.routes["POST /api/master/table-qr/scan"] = () => ({ status: "inactive", table: { code: "T09" }, outletName: "Closed", restaurantName: "Coders' Cafe", tokenHint: "••••abc", environment: VALID.environment, message: "switched off" });
    await paste(QR);
    expect(await screen.findByTestId("scan-inactive")).toHaveTextContent(/T09/);
    expect(screen.queryByRole("link", { name: /open customer ordering page/i })).toBeNull();
    teardown();
    installFetch();
    state.routes = { "POST /api/master/table-qr/scan": () => ({ status: "not_found", tokenHint: "••••abc", environment: VALID.environment, message: "no table here uses it" }) };
    await paste(QR);
    const box = await screen.findByTestId("scan-not-found");
    expect(box).toHaveTextContent(/no table here uses it/);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /enter the link manually/i })).toHaveAttribute("href", "#qr-manual");
  });

  it("a server error is shown, not thrown", async () => {
    state.routes["POST /api/master/table-qr/scan"] = () => ({ __status: 429, error: { code: "RateLimited", message: "Too many requests" } });
    await paste(QR);
    expect(await screen.findByTestId("scan-failed")).toBeInTheDocument();
  });

  it("only a guest link on this deployment's own origin is ever offered", () => {
    expect(safeGuestLink(VALID)).toBe(QR);
    for (const guestUrl of ["https://evil.example/t/" + TOKEN, "javascript:alert(1)", `${APP}/t/${TOKEN}?x=1`, `${APP}/login`]) {
      expect(safeGuestLink({ ...VALID, guestUrl } as ScanResult), guestUrl).toBeNull();
    }
    expect(safeGuestLink({ status: "rejected", reason: "bad_token", message: "x" })).toBeNull();
  });
});

describe("image upload", () => {
  const png = (bytes = 10) => new File([new Uint8Array(bytes)], "qr.png", { type: "image/png" });

  it("decodes an uploaded photo and checks it on the server", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 400, height: 400, close: vi.fn() })));
    decodeMock.mockResolvedValue(QR);
    const cam = fakeCamera();
    render(<TableQrScannerScreen media={cam.media} />);
    fireEvent.change(screen.getByLabelText(/choose image/i), { target: { files: [png()] } });
    expect(await screen.findByTestId("scan-valid")).toBeInTheDocument();
    expect(decodeMock).toHaveBeenCalledWith(expect.anything(), { thorough: true });
    expect(cam.getUserMedia).not.toHaveBeenCalled(); // no camera needed
    // "Scan another" after an upload does not switch the camera on.
    fireEvent.click(screen.getByRole("button", { name: /scan another qr/i }));
    expect(cam.getUserMedia).not.toHaveBeenCalled();
  });

  it("explains unreadable images instead of crashing", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 400, height: 400, close: vi.fn() })));
    decodeMock.mockResolvedValue(null);
    render(<TableQrScannerScreen media={fakeCamera().media} />);
    fireEvent.change(screen.getByLabelText(/choose image/i), { target: { files: [png()] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/no qr code was found/i);
    expect(scans()).toHaveLength(0);
  });

  it("refuses non-images, oversized files and undecodable images with a reason", async () => {
    const dec = { kind: "jsqr" as const, decode: decodeMock };
    await expect(decodeQrImageFile(new File(["x"], "a.txt", { type: "text/plain" }), dec)).rejects.toMatchObject({ problem: "not_image" });
    const big = png(1);
    Object.defineProperty(big, "size", { value: MAX_IMAGE_BYTES + 1 });
    await expect(decodeQrImageFile(big, dec)).rejects.toMatchObject({ problem: "too_large" });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      throw new Error("bad image");
    }));
    // jsdom's <img> cannot decode either → unreadable
    await expect(decodeQrImageFile(png(), dec)).rejects.toBeInstanceOf(ImageScanError);
  });
});
