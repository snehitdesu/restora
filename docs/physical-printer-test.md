# Physical bill / receipt printer test (owner steps)

Status 2026-10-20: **software printing verified; physical printer not
verified.** This PC has no receipt printer installed (only Microsoft Print to
PDF, XPS Document Writer, OneNote, Fax and WPS PDF, all virtual), so no paper
test was run.

Verified in software: bill / receipt content, unpaid / part-paid / paid /
cancelled / partly refunded / refunded states, INR and invoice number, 58 mm
(32 columns) and 80 mm (48 columns) ESC/POS layouts, print styles that hide the
controls, and that viewing, printing and reprinting never create a payment,
invoice, stock movement or KOT (`tests/domain/bill-printing.test.ts`,
`e2e/bill-print.spec.ts` BILL-001, ESC/POS against a real TCP socket in
`tests/integrations/phase7-units.test.ts`).

RESTORA prints in two ways. Test the one the restaurant will use.

## Before the test (check once, 10 minutes)

- [ ] Which printer, exactly (make, model, 58 or 80 mm), and how it connects:
      Ethernet / Wi-Fi (method A) or USB to a Windows PC (method B only;
      RESTORA has no USB ESC/POS driver).
- [ ] For method A: the manual says it accepts raw TCP on port 9100.
- [ ] Paper roll loaded; the RESTORA server / desktop PC and the printer on the
      same network (method A).
- [ ] An OWNER or MANAGER login (Printers & drawer is an admin screen).
- [ ] Time to cancel / refund the test order afterwards (step A.9).

## A. Network ESC/POS receipt printer (recommended for the counter)

Needs an Ethernet / Wi-Fi thermal printer that accepts raw ESC/POS on TCP port
9100 (most Epson TM, TVS RP, Posiflex, Everycom models; check the manual for
"raw TCP / port 9100").

1. Load paper. Print the printer's own self-test page (usually: hold FEED while
   powering on). Note the **IP address** it prints, and its paper width (58 or
   80 mm).
2. Give it a fixed IP on the router (DHCP reservation), on the same network as
   the RESTORA server / desktop. RESTORA only accepts private addresses
   (10.x, 172.16-31.x, 192.168.x) and ports 9100-9109.
3. RESTORA → **Admin → Printers & drawer** (`/settings/printers`) → **Add
   printer**: role **Receipt**, connection **Network (ESC/POS)**, the IP, port
   9100, **Characters / line** 32 for 58 mm paper or 42-48 for 80 mm. Save.
4. Press **Check**: it only opens a connection (nothing prints). It must say
   reachable.
5. Press **Test print**: one short test slip should come out and be cut. If it
   says failed, the slip did not print; read the error (refused / timeout =
   wrong IP, printer off or another network).
6. Real bill: in POS, open a test order, add one item, take a **cash** payment,
   then **Bill → Send to printer**. Check on paper: restaurant name and
   address, items with quantities and sizes / add-ons, discount, GST lines,
   total in ₹, "Paid", the invoice number, and that no line is cut off.
7. Tap **Send to printer** again: RESTORA says it was already sent (no second
   copy). **Reprint** with a reason gives a second copy and is audited. Neither
   creates a payment, invoice or kitchen ticket.
8. Pull the network cable and send again: RESTORA must report *Print failed*,
   not *Printed*. Reconnect and use **Retry** under Printers & drawer → Print jobs.
9. Afterwards, cancel or refund the test order as you normally would, so it
   does not count as a sale.

## B. Browser printing (any printer Windows can print to)

1. Install the printer in Windows and print a Windows test page.
2. Open a bill (POS → order → **Bill**) and press **Print bill / Print
   receipt**. In the browser dialog pick the printer, set paper size to the roll
   width (or A4), margins *None*, and turn off headers and footers.
3. Check the same points as A.6. The browser does not tell RESTORA whether
   paper came out, so the page only says the dialog closed. Cancelling the
   dialog and printing again is safe.

## Record (copy into the go-live checklist, item G)

| Field | Value |
| --- | --- |
| Date / who checked | |
| Printer make + model, paper width | |
| Method (A network / B browser), IP + port for A | |
| A.4 Check reachable | pass / fail |
| A.5 Test slip printed and cut | pass / fail |
| A.6 Bill content complete (name, address, items, sizes / add-ons, GST, ₹ total, Paid, invoice number, nothing cut off) | pass / fail + photo of the slip |
| A.7 Second send refused; reprint audited | pass / fail |
| A.8 Cable out → *Print failed*; Retry works | pass / fail |
| Test order cancelled / refunded | yes / no |

A fail on A.6 (missing or cut text) usually means the wrong *Characters /
line*: try 32 for 58 mm, 42 then 48 for 80 mm, and test again.
