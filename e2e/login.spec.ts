import { test, expect } from "@playwright/test";
import { PASSWORD, ROLES, appAlert } from "./helpers";

test.describe("authentication", () => {
  test("LOGIN-001 manager signs in and reaches dashboard, POS and KDS", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByLabel("RESTORA")).toBeVisible();
    await page.getByLabel("Email").fill(ROLES.manager);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "POS" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Kitchen" })).toBeVisible();

    // No secret material in the rendered document; the session cookie is httpOnly.
    const html = await page.content();
    expect(html).not.toContain(PASSWORD);
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "aharos_session");
    expect(session?.httpOnly).toBe(true);
    expect(html).not.toContain(session!.value);
    expect(await page.evaluate(() => document.cookie)).not.toContain("aharos_session");

    await page.goto("/pos");
    await expect(page.getByRole("region", { name: "Menu" })).toBeVisible();
    await page.goto("/kitchen");
    await expect(page.getByRole("region", { name: /^New/ })).toBeVisible();
  });

  test("LOGIN-002 wrong password stays signed out with a clear error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ROLES.manager);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(appAlert(page)).toHaveText("Invalid email or password");
    await expect(page).toHaveURL(/\/login/);
    expect((await page.context().cookies()).some((c) => c.name === "aharos_session")).toBe(false);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  });

  test("LOGIN-002b typing before the page hydrates is kept, and an early submit never puts credentials in the URL", async ({ page }) => {
    // Slow device: hold back the scripts so the form is on screen but not yet interactive. This is
    // what a slow CI runner does by itself (found as an intermittent desktop E2E login failure).
    await page.route("**/_next/static/**/*.js", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto("/login?next=%2Fpos", { waitUntil: "commit" });
    await page.getByLabel("Email").fill(ROLES.manager);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.waitForLoadState("load");
    await page.unroute("**/_next/static/**/*.js");
    // After hydration the typed text is still there and signing in uses it.
    await expect(page.getByLabel("Email")).toHaveValue(ROLES.manager);
    await page.waitForFunction(() => typeof (window as unknown as { next?: unknown }).next === "object");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/pos$/);

    // Submitting before hydration: the browser posts the form; nothing sensitive reaches the address bar.
    await page.context().clearCookies();
    await page.route("**/_next/static/**/*.js", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto("/login", { waitUntil: "commit" });
    await page.getByLabel("Email").fill(ROLES.manager);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForLoadState("load");
    expect(page.url()).not.toContain(PASSWORD);
    expect(page.url()).not.toContain("password=");
    expect(new URL(page.url()).search).toBe("");
  });

  test("LOGIN-003 signed-out /pos redirects to login", async ({ page }) => {
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/login\?next=%2Fpos$/);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("LOGIN-004 signed-out /kitchen redirects to login", async ({ page }) => {
    await page.goto("/kitchen");
    await expect(page).toHaveURL(/\/login\?next=%2Fkitchen$/);
  });

  test("LOGIN-005 after login the user returns to the page they asked for", async ({ page }) => {
    await page.goto("/kitchen");
    await page.getByLabel("Email").fill(ROLES.kitchen);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/kitchen$/);
  });
});
