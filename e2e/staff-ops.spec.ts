/**
 * STAFFOPS-001 roster through the real production build: the manager adds a shift, puts a team member on it for today, the
 * roster API and the grid agree, a second overlapping shift is refused with the reason, and removing the entry empties the cell.
 * STAFFOPS-002 a checklist is built from the screen, started for today (one task per item, on the Tasks screen), and starting it
 * again adds nothing.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiData, apiCall, apiAs, CENTRAL } from "./helpers";

const RUN = Date.now().toString(36);
const TZ = "Asia/Kolkata";
const todayInTz = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

test.describe("staff operations (desktop)", () => {
  test.use({ storageState: statePath("manager") });

  test("STAFFOPS-001 roster: add a shift, put someone on it, overlap refused, take them off", async ({ page }) => {
    const owner = await apiAs("owner");
    const central = await outletByCode(owner, CENTRAL);
    const team = await apiData<{ items: Array<{ id: string; name: string; email: string }> }>(owner, `/api/staff?outletId=${central.id}&take=200`);
    const cashier = team.items.find((u) => u.email === "cashier@demo.local")!;
    const date = todayInTz();

    await page.goto("/staff/roster");
    await page.getByRole("button", { name: /New shift/ }).click();
    const shiftDlg = page.getByRole("dialog", { name: "New shift" });
    await shiftDlg.getByLabel(/^Name/).fill(`Early ${RUN}`);
    await shiftDlg.getByLabel(/^Starts/).fill("06:00");
    await shiftDlg.getByLabel(/^Ends/).fill("10:00");
    await shiftDlg.getByRole("button", { name: "Add shift" }).click();
    await expect(shiftDlg).toBeHidden();
    await page.getByRole("button", { name: /New shift/ }).click();
    await shiftDlg.getByLabel(/^Name/).fill(`Overlap ${RUN}`);
    await shiftDlg.getByLabel(/^Starts/).fill("09:00");
    await shiftDlg.getByLabel(/^Ends/).fill("12:00");
    await shiftDlg.getByRole("button", { name: "Add shift" }).click();
    await expect(shiftDlg).toBeHidden();

    const grid = page.getByRole("table", { name: /Roster for the week starting/ });
    await grid.getByRole("button", { name: `Put someone on Early ${RUN} on ${date}` }).click();
    const assign = page.getByRole("dialog", { name: new RegExp(`Early ${RUN}`) });
    await assign.getByRole("combobox").selectOption({ label: cashier.name });
    await assign.getByRole("button", { name: "Put on shift" }).click();
    await expect(assign).toBeHidden();
    const early = grid.getByRole("row", { name: new RegExp(`Early ${RUN}`) });
    await expect(early).toContainText(cashier.name);

    const roster = await apiData<{ days: Array<{ date: string; shifts: Array<{ name: string; people: Array<{ userId: string; assignmentId: string }> }> }> }>(owner, `/api/staff/roster?outletId=${central.id}&from=${date}&days=1`);
    const mine = roster.days[0].shifts.find((s) => s.name === `Early ${RUN}`)!.people;
    expect(mine.map((p) => p.userId)).toEqual([cashier.id]);

    // 09:00-12:00 overlaps 06:00-10:00 for the same person: refused, with the reason, and nothing is written.
    await grid.getByRole("button", { name: `Put someone on Overlap ${RUN} on ${date}` }).click();
    const second = page.getByRole("dialog", { name: new RegExp(`Overlap ${RUN}`) });
    await second.getByRole("combobox").selectOption({ label: cashier.name });
    await second.getByRole("button", { name: "Put on shift" }).click();
    await expect(second.getByRole("alert")).toContainText("overlaps");
    await second.getByRole("button", { name: "Cancel" }).click();
    await expect(grid.getByRole("row", { name: new RegExp(`Overlap ${RUN}`) })).not.toContainText(cashier.name);

    // The person sees it on their own screen.
    const mineCtx = await apiAs("cashier");
    const shifts = await apiData<Array<{ date: string; shift: string }>>(mineCtx, `/api/staff/my-shifts?from=${date}&days=1`);
    expect(shifts.map((s) => s.shift)).toContain(`Early ${RUN}`);
    await mineCtx.dispose();

    await grid.getByRole("button", { name: `Remove ${cashier.name} from Early ${RUN} on ${date}` }).click();
    await page.getByRole("dialog", { name: new RegExp(`Take ${cashier.name} off`) }).getByRole("button", { name: "Remove" }).click();
    await expect(early).not.toContainText(cashier.name);
    await owner.dispose();
  });

  test("STAFFOPS-002 checklist: build it, start it for today, once", async ({ page }) => {
    const owner = await apiAs("owner");
    const central = await outletByCode(owner, CENTRAL);
    const name = `Opening ${RUN}`;

    await page.goto("/staff/checklists");
    await page.getByRole("button", { name: /New checklist/ }).click();
    const dlg = page.getByRole("dialog", { name: "New checklist" });
    await dlg.getByLabel(/^Name/).fill(name);
    await dlg.getByLabel("Item 1", { exact: true }).fill(`Unlock ${RUN}`);
    await dlg.getByRole("button", { name: /Add item/ }).click();
    await dlg.getByLabel("Item 2", { exact: true }).fill(`Fridges ${RUN}`);
    await dlg.getByRole("button", { name: "Create checklist" }).click();
    await expect(dlg).toBeHidden();

    const table = page.getByRole("table", { name: "Checklists" });
    const row = table.getByRole("row").filter({ hasText: name });
    await expect(row).toContainText("2 items");
    await expect(row).toContainText("Not started");
    try {
      await row.getByRole("button", { name: `Start ${name} for today` }).click();
      await expect(row).toContainText("0 of 2 done");
      const tasks = await apiData<{ items: Array<{ id: string; title: string; status: string }> }>(owner, `/api/staff/tasks?outletId=${central.id}&take=200`);
      expect(tasks.items.filter((t) => t.title.endsWith(RUN) && t.status === "OPEN")).toHaveLength(2);

      // Again: nothing new.
      const again = await apiCall<{ created: number; existing: number }>(owner, "POST", `/api/staff/checklists/${(await apiData<Array<{ id: string; name: string }>>(owner, `/api/staff/checklists?outletId=${central.id}`)).find((t) => t.name === name)!.id}/start`, {});
      expect(again.body!.data).toMatchObject({ created: 0, existing: 2 });

      // The manager works the first task from the Tasks screen and the checklist shows it.
      await page.goto("/staff/tasks");
      const taskRow = page.getByRole("table", { name: "Tasks" }).getByRole("row").filter({ hasText: `Unlock ${RUN}` });
      await taskRow.getByRole("button", { name: "Start" }).click();
      await expect(taskRow.getByRole("button", { name: "Done" })).toBeVisible();
      await taskRow.getByRole("button", { name: "Done" }).click();
      await page.goto("/staff/checklists");
      await expect(table.getByRole("row").filter({ hasText: name })).toContainText("1 of 2 done");
    } finally {
      // Leave the shared task list as it was: cancel what this test started.
      const tasks = await apiData<{ items: Array<{ id: string; title: string; status: string }> }>(owner, `/api/staff/tasks?outletId=${central.id}&take=200`);
      for (const t of tasks.items.filter((x) => x.title.endsWith(RUN) && x.status !== "CANCELLED" && x.status !== "VERIFIED")) await apiCall(owner, "POST", `/api/staff/tasks/${t.id}/cancel`, {});
    }
    await owner.dispose();
  });
});
