/**
 * Reads the guest-menu path written by scripts/site/demo-state.ts (see
 * demo-qr.ts). Only a relative `/t/<token>` path in the guest token format is
 * accepted: never an absolute URL or another route, so the screenshot run can
 * only open the guest page of the server it was pointed at.
 */
import fs from "node:fs";
import path from "node:path";

export const GUEST_PATH_FILE = path.join("artifacts", "table-qr", "site-demo", "guest-path.txt");
const GUEST_PATH_RE = /^\/t\/[A-Za-z0-9_-]{6,64}$/;

export function readGuestPath(file = GUEST_PATH_FILE) {
  const value = fs.readFileSync(file, "utf8").trim();
  if (!GUEST_PATH_RE.test(value)) throw new Error(`${file} does not hold a /t/<token> guest path; rerun scripts/site/demo-state.ts`);
  return value;
}
