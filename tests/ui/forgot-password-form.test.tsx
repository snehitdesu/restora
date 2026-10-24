// @vitest-environment jsdom
/**
 * The reset-request form (shown when password-reset email is configured): the
 * address is read from the field at submit, so text typed before the page
 * hydrated is used; an empty form is explained and focused, never silently
 * disabled; the answer says whether an email is on its way or a manager issues
 * the link. (In a real browser, typing before hydration: e2e LOGIN-002b.)
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ForgotPasswordForm } from "@/app/forgot-password/ForgotPasswordForm";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

let bodies: unknown[] = [];
let delivery: "email" | "manager" = "email";

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      bodies.push(init.body ? JSON.parse(init.body as string) : undefined);
      const message = delivery === "email" ? "If an active account exists for that email, a reset link will be sent to it." : "Password reset by email is not set up for this workspace, so no email was sent.";
      return new Response(JSON.stringify({ ok: true, data: { message, delivery } }), { status: 202 });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("forgot-password form", () => {
  it("an empty form is explained and the field focused; nothing is sent", async () => {
    render(<ForgotPasswordForm />);
    const button = screen.getByRole("button", { name: "Request reset link" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await screen.findByText("Enter the email address of your account")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(bodies).toHaveLength(0);
  });

  it("uses what is in the field at submit, even text React never saw (typed before hydration)", async () => {
    render(<ForgotPasswordForm />);
    // Set the DOM value without a React change event, as a browser does for typing before hydration.
    (screen.getByLabelText("Email") as HTMLInputElement).value = "  early@example.test ";
    fireEvent.click(screen.getByRole("button", { name: "Request reset link" }));
    expect(await screen.findByText(/a reset link will be sent/)).toBeInTheDocument();
    expect(bodies).toEqual([{ email: "early@example.test" }]);
  });

  it("says when no email is sent (a manager issues the link)", async () => {
    delivery = "manager";
    render(<ForgotPasswordForm />);
    (screen.getByLabelText("Email") as HTMLInputElement).value = "someone@example.test";
    fireEvent.click(screen.getByRole("button", { name: "Request reset link" }));
    await waitFor(() => expect(screen.getByText(/no email was sent/)).toBeInTheDocument());
    delivery = "email";
  });
});
