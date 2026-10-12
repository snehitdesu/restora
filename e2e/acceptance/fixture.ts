/** What prepare-db.ts creates and acceptance.spec.ts asserts: one definition, two readers. */
import path from "node:path";

export const ACCEPTANCE_DB_PATH = path.join(process.cwd(), "prisma", "e2e-acceptance.db");

/** The Coders' Cafe order under test: 1 × Loaded Veg Nachos, ₹150 + 5% GST = ₹157.50. */
export const DISH = { name: "Loaded Veg Nachos", price: 150, taxPct: 5, total: 157.5, tax: 7.5, cgst: 3.75, sgst: 3.75 } as const;

/** A registered business (the sample GSTIN used by the invoice tests): invoices split CGST / SGST. */
export const CAFE_GSTIN = "27AAPFU0939F1ZV";

/** Per plate (kg) and received stock (kg at ₹/kg) in the kitchen department. */
export const INGREDIENTS = [
  { sku: "ACC-CHIPS", name: "Nacho chips", perPlate: 0.2, openingQty: 10, rate: 120 },
  { sku: "ACC-CHEESE", name: "Cheese sauce", perPlate: 0.1, openingQty: 5, rate: 300 },
] as const;

export const OTHER = {
  orgName: "Maple Biryani House",
  ownerEmail: "other.owner@demo.local",
  tableToken: "ccOtherRestaurantTableX01",
  dish: "Maple Chicken Biryani",
} as const;
