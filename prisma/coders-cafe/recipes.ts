/**
 * Coders' Cafe — DRAFT recipes with ESTIMATED quantities, for the investor demo.
 *
 * Provenance: the owner supplied the menu boards (./menu.ts), not recipes. Every
 * ingredient list, quantity, method and time below was written for the demo from
 * the dish names alone: none of it is the kitchen's weighed recipe. So:
 *  - every recipe is created as a DRAFT version with `estimated: true`, which
 *    RESTORA never uses for stock consumption, purchasing or food cost and which
 *    cannot be approved until someone with recipe.manage confirms the quantities
 *    (services/recipe.ts approveRecipeVersion);
 *  - no ingredient prices are invented: materials carry no cost, so the recipe
 *    screen shows "No cost" until real purchases are received;
 *  - allergens are NOT verified. The notes list only what this draft's own
 *    ingredient list contains, and say so; nothing is ever labelled allergen-free;
 *  - quantities are for the board's base (Regular / smallest) size. The menu's
 *    Medium / Large variants keep their consumption factor (1×) untouched: the
 *    menu is the owner's and is not edited here.
 *
 * Not covered (contents not readable on the boards, so not guessed):
 * NOT_COVERED below. The menu itself is never changed by this module.
 */
import type { PrismaClient } from "@prisma/client";
import type { AccessContext } from "@/server/db/scope";
import { createMaterial, createUnit } from "@/server/services/masterData";
import { createRecipe } from "@/server/services/recipe";

type UnitCode = "g" | "ml" | "pc";
type Allergen = "milk" | "wheat (gluten)" | "egg";
type Ingredient = { sku: string; name: string; unit: UnitCode; allergens?: Allergen[] };

const MILK: Allergen[] = ["milk"];
const WHEAT: Allergen[] = ["wheat (gluten)"];

/** Generic ingredients (no brands, no prices). SKUs are stable so re-running finds them. */
export const DRAFT_INGREDIENTS: Ingredient[] = [
  { sku: "CC-FRIES", name: "Frozen french fries", unit: "g" },
  { sku: "CC-WEDGES", name: "Frozen potato wedges", unit: "g" },
  { sku: "CC-POTATO", name: "Potato", unit: "g" },
  { sku: "CC-ONION", name: "Onion", unit: "g" },
  { sku: "CC-TOMATO", name: "Tomato", unit: "g" },
  { sku: "CC-CAPSICUM", name: "Capsicum", unit: "g" },
  { sku: "CC-CORN", name: "Sweet corn", unit: "g" },
  { sku: "CC-MUSHROOM", name: "Button mushroom", unit: "g" },
  { sku: "CC-BROCCOLI", name: "Broccoli", unit: "g" },
  { sku: "CC-JALAPENO", name: "Jalapeno (sliced)", unit: "g" },
  { sku: "CC-OLIVES", name: "Black olives (sliced)", unit: "g" },
  { sku: "CC-LETTUCE", name: "Lettuce", unit: "g" },
  { sku: "CC-CUCUMBER", name: "Cucumber", unit: "g" },
  { sku: "CC-GARLIC", name: "Garlic", unit: "g" },
  { sku: "CC-GGPASTE", name: "Ginger garlic paste", unit: "g" },
  { sku: "CC-CURRYLEAF", name: "Curry leaves", unit: "g" },
  { sku: "CC-LEMON", name: "Lemon juice", unit: "ml" },
  { sku: "CC-MAIDA", name: "Refined flour (maida)", unit: "g", allergens: WHEAT },
  { sku: "CC-CORNFLOUR", name: "Cornflour", unit: "g" },
  { sku: "CC-CRUMBS", name: "Panko breadcrumbs", unit: "g", allergens: WHEAT },
  { sku: "CC-BULGUR", name: "Bulgur wheat", unit: "g", allergens: WHEAT },
  { sku: "CC-PENNE", name: "Penne pasta (dry)", unit: "g", allergens: WHEAT },
  { sku: "CC-SPAGHETTI", name: "Spaghetti (dry)", unit: "g", allergens: WHEAT },
  { sku: "CC-PIZZABASE", name: "Thin crust pizza base (regular)", unit: "pc", allergens: WHEAT },
  { sku: "CC-CHIPS", name: "Tortilla chips", unit: "g" },
  { sku: "CC-EGG", name: "Egg", unit: "pc", allergens: ["egg"] },
  { sku: "CC-CHICKEN", name: "Chicken, boneless", unit: "g" },
  { sku: "CC-CHICKBONE", name: "Chicken, bone-in pieces", unit: "g" },
  { sku: "CC-CHICKMINCE", name: "Chicken mince (kheema)", unit: "g" },
  { sku: "CC-WINGS", name: "Chicken wings", unit: "pc" },
  { sku: "CC-PANEER", name: "Paneer", unit: "g", allergens: MILK },
  { sku: "CC-MOZZ", name: "Mozzarella cheese", unit: "g", allergens: MILK },
  { sku: "CC-CHEESESAUCE", name: "Cheese sauce", unit: "g", allergens: MILK },
  { sku: "CC-BUTTER", name: "Butter", unit: "g", allergens: MILK },
  { sku: "CC-CREAM", name: "Fresh cream", unit: "ml", allergens: MILK },
  { sku: "CC-MILK", name: "Milk", unit: "ml", allergens: MILK },
  { sku: "CC-CURD", name: "Curd (yogurt)", unit: "g", allergens: MILK },
  { sku: "CC-MAYO", name: "Mayonnaise", unit: "g", allergens: ["egg"] },
  { sku: "CC-SALSA", name: "Salsa", unit: "g" },
  { sku: "CC-TOMPUREE", name: "Tomato puree", unit: "g" },
  { sku: "CC-PIZZASAUCE", name: "Pizza sauce", unit: "g" },
  { sku: "CC-BBQ", name: "BBQ sauce", unit: "ml" },
  { sku: "CC-HOTSAUCE", name: "Hot sauce", unit: "ml" },
  { sku: "CC-OIL", name: "Refined oil (frying)", unit: "ml" },
  { sku: "CC-OLIVEOIL", name: "Olive oil", unit: "ml" },
  { sku: "CC-SALT", name: "Salt", unit: "g" },
  { sku: "CC-PEPPER", name: "Black pepper", unit: "g" },
  { sku: "CC-CHILLI", name: "Red chilli powder", unit: "g" },
  { sku: "CC-GUNTUR", name: "Guntur dry red chilli", unit: "g" },
  { sku: "CC-FLAKES", name: "Chilli flakes", unit: "g" },
  { sku: "CC-HERBS", name: "Mixed dried herbs", unit: "g" },
  { sku: "CC-CAJUN", name: "Cajun seasoning", unit: "g" },
  { sku: "CC-PERIPERI", name: "Peri peri seasoning", unit: "g" },
  { sku: "CC-TANDOORI", name: "Tandoori masala", unit: "g" },
];

export type DraftRecipe = {
  /** Exact menu item name (./menu.ts). */
  item: string;
  /** [ingredient sku, quantity in the ingredient's unit] per portion. */
  lines: Array<[string, number]>;
  method: string;
  /** Estimated preparation + cooking time, minutes. */
  minutes: number;
  /** Anything a reader must know about this draft (e.g. one recipe for two flavours). */
  caveat?: string;
};

const FRY = (oil: number): Array<[string, number]> => [["CC-OIL", oil]];
const ALFREDO: Array<[string, number]> = [["CC-CREAM", 80], ["CC-MILK", 50], ["CC-BUTTER", 10], ["CC-GARLIC", 4], ["CC-MAIDA", 5], ["CC-MOZZ", 20], ["CC-HERBS", 1], ["CC-SALT", 1]];
const ARRABBIATA: Array<[string, number]> = [["CC-TOMPUREE", 100], ["CC-GARLIC", 5], ["CC-FLAKES", 2], ["CC-OLIVEOIL", 10], ["CC-ONION", 20], ["CC-HERBS", 1], ["CC-SALT", 1]];
const PINK: Array<[string, number]> = [["CC-TOMPUREE", 70], ["CC-CREAM", 50], ["CC-BUTTER", 10], ["CC-GARLIC", 4], ["CC-HERBS", 1], ["CC-SALT", 1]];
const VEG_MIX: Array<[string, number]> = [["CC-CAPSICUM", 20], ["CC-CORN", 20], ["CC-MUSHROOM", 20]];
const PASTA_CHICKEN: Array<[string, number]> = [["CC-CHICKEN", 80]];
const PIZZA = (cheese = 60): Array<[string, number]> => [["CC-PIZZABASE", 1], ["CC-PIZZASAUCE", 40], ["CC-MOZZ", cheese]];
const PASTA_METHOD = (sauce: string) => `Boil the pasta al dente. Make the ${sauce} sauce in a pan, add the vegetables / protein, toss in the pasta and finish with herbs.`;
const PIZZA_METHOD = "Spread sauce on the thin crust base, add cheese and toppings, bake until the cheese melts and the edges crisp, cut and serve.";

function wings(name: string, pieces: number, sauce: Array<[string, number]>, sauceLabel: string): DraftRecipe {
  const n = pieces;
  return {
    item: `${name} (${pieces} Pc)`,
    lines: [["CC-WINGS", n], ["CC-MAIDA", 8 * n], ["CC-CORNFLOUR", 3 * n], ["CC-SALT", 0.5 * n], ["CC-OIL", 12 * n], ...sauce.map(([sku, q]) => [sku, q * n] as [string, number])],
    method: `Coat the wings in seasoned flour, deep-fry until cooked through and crisp, then toss in the ${sauceLabel}.`,
    minutes: 12 + Math.round(n / 2),
  };
}

const BUTTER_GARLIC: Array<[string, number]> = [["CC-BUTTER", 5], ["CC-GARLIC", 2]];
const CREAMY: Array<[string, number]> = [["CC-CREAM", 8], ["CC-GARLIC", 1]];
const BBQ: Array<[string, number]> = [["CC-BBQ", 8]];
const SPICY: Array<[string, number]> = [["CC-HOTSAUCE", 6], ["CC-CHILLI", 0.5]];

export const DRAFT_RECIPES: DraftRecipe[] = [
  // Appetizers
  { item: "Crisp Cajun Onion Rings", lines: [["CC-ONION", 120], ["CC-MAIDA", 40], ["CC-CORNFLOUR", 15], ["CC-CRUMBS", 30], ["CC-CAJUN", 4], ["CC-SALT", 1], ...FRY(40)], method: "Slice the onion into rings, dip in seasoned batter, coat in crumbs, deep-fry until golden and dust with Cajun seasoning.", minutes: 12 },
  { item: "Classic Fries", lines: [["CC-FRIES", 150], ["CC-SALT", 2], ...FRY(30)], method: "Deep-fry the fries until golden and salt them.", minutes: 7 },
  { item: "Peri Peri/Lemon Garlic Fries", lines: [["CC-FRIES", 150], ["CC-PERIPERI", 4], ["CC-GARLIC", 3], ["CC-LEMON", 5], ["CC-SALT", 1], ...FRY(30)], method: "Deep-fry the fries and toss with peri peri seasoning, or with garlic and lemon.", minutes: 8, caveat: "One draft for both flavours: the board sells them as one item; the guest's choice changes the seasoning only." },
  { item: "Cheesy Juicy Fries", lines: [["CC-FRIES", 150], ["CC-CHEESESAUCE", 60], ["CC-FLAKES", 1], ["CC-SALT", 1], ...FRY(30)], method: "Deep-fry the fries and pour warm cheese sauce over them.", minutes: 8 },
  { item: "Baked Potato Wedges", lines: [["CC-WEDGES", 180], ["CC-OIL", 15], ["CC-HERBS", 2], ["CC-SALT", 2]], method: "Toss the wedges in oil, herbs and salt and bake until crisp.", minutes: 15 },
  { item: "Jalapeno Cheese Balls", lines: [["CC-POTATO", 60], ["CC-MOZZ", 60], ["CC-JALAPENO", 15], ["CC-MAIDA", 15], ["CC-CRUMBS", 30], ["CC-SALT", 1], ...FRY(40)], method: "Mix mashed potato, cheese and jalapeno, roll into balls, coat in batter and crumbs, deep-fry.", minutes: 15 },
  { item: "Cheese Stuffed Mushroom", lines: [["CC-MUSHROOM", 120], ["CC-MOZZ", 40], ["CC-GARLIC", 3], ["CC-BUTTER", 10], ["CC-CRUMBS", 10], ["CC-HERBS", 1]], method: "Stuff the mushroom caps with garlic-butter cheese, top with crumbs and bake.", minutes: 15 },
  { item: "Chilli Cheese Nachos", lines: [["CC-CHIPS", 80], ["CC-CHEESESAUCE", 50], ["CC-JALAPENO", 10], ["CC-FLAKES", 1], ["CC-SALSA", 30]], method: "Layer the chips with cheese sauce, jalapeno and chilli; serve with salsa.", minutes: 6 },
  { item: "Broccoli Cheese Kibbeh", lines: [["CC-BULGUR", 50], ["CC-BROCCOLI", 60], ["CC-MOZZ", 30], ["CC-ONION", 20], ["CC-MAIDA", 10], ["CC-SALT", 1], ...FRY(40)], method: "Soak the bulgur, mix with onion and flour, shape around a broccoli-cheese filling and deep-fry.", minutes: 20 },

  // Chicken Delites
  { item: "Guntur Chiken 65", lines: [["CC-CHICKEN", 200], ["CC-GUNTUR", 6], ["CC-GGPASTE", 10], ["CC-CURD", 20], ["CC-CORNFLOUR", 15], ["CC-MAIDA", 10], ["CC-CURRYLEAF", 2], ["CC-SALT", 2], ...FRY(50)], method: "Marinate the chicken with ginger-garlic, curd and Guntur chilli, coat, deep-fry and temper with curry leaves.", minutes: 15 },
  { item: "Popcorn Chicken", lines: [["CC-CHICKEN", 120], ["CC-MAIDA", 30], ["CC-CORNFLOUR", 15], ["CC-CRUMBS", 20], ["CC-EGG", 0.5], ["CC-PEPPER", 1], ["CC-SALT", 1], ...FRY(40)], method: "Cut the chicken into bite-size pieces, bread them and deep-fry until crisp.", minutes: 12 },
  { item: "Chicken Nuggets", lines: [["CC-CHICKMINCE", 120], ["CC-CRUMBS", 30], ["CC-MAIDA", 15], ["CC-EGG", 0.5], ["CC-SALT", 1], ...FRY(40)], method: "Season the mince, shape nuggets, bread them and deep-fry.", minutes: 12 },
  { item: "Crunchy Chicken (3 Pc)", lines: [["CC-CHICKBONE", 300], ["CC-MAIDA", 50], ["CC-CORNFLOUR", 15], ["CC-EGG", 1], ["CC-CHILLI", 3], ["CC-SALT", 2], ...FRY(80)], method: "Marinate three bone-in pieces, double-coat in seasoned flour and deep-fry until cooked through.", minutes: 18 },
  { item: "Chicken Cheese Balls", lines: [["CC-CHICKMINCE", 100], ["CC-MOZZ", 40], ["CC-CRUMBS", 30], ["CC-EGG", 0.5], ["CC-SALT", 1], ...FRY(40)], method: "Wrap cheese in seasoned chicken mince, bread the balls and deep-fry.", minutes: 15 },
  { item: "Chicken Strips (3 Pc)", lines: [["CC-CHICKEN", 150], ["CC-MAIDA", 30], ["CC-CRUMBS", 30], ["CC-EGG", 0.5], ["CC-PEPPER", 1], ["CC-SALT", 1], ...FRY(40)], method: "Cut three strips, bread them and deep-fry.", minutes: 12 },
  { item: "Panco Fried Chicken", lines: [["CC-CHICKEN", 150], ["CC-CRUMBS", 40], ["CC-MAIDA", 20], ["CC-EGG", 1], ["CC-SALT", 1], ...FRY(50)], method: "Flour, egg and panko-coat the chicken and deep-fry until golden.", minutes: 14 },
  { item: "BBQ Grilled Chicken", lines: [["CC-CHICKEN", 200], ["CC-BBQ", 40], ["CC-GGPASTE", 10], ["CC-OIL", 10], ["CC-SALT", 1]], method: "Marinate the chicken in BBQ sauce and ginger-garlic, grill and baste.", minutes: 20 },
  { item: "Spicy Grilled Chicken", lines: [["CC-CHICKEN", 200], ["CC-CURD", 30], ["CC-CHILLI", 5], ["CC-GGPASTE", 10], ["CC-LEMON", 5], ["CC-OIL", 10], ["CC-SALT", 1]], method: "Marinate the chicken in spiced curd, grill until charred and cooked through.", minutes: 20 },

  // Tossed Wings
  ...[6, 9, 12].map((n) => wings("Butter Garlic Wings", n, BUTTER_GARLIC, "butter-garlic sauce")),
  ...[6, 9, 12].map((n) => wings("Creamy Chicken Wings", n, CREAMY, "creamy garlic sauce")),
  ...[6, 9, 12].map((n) => wings("BBQ Chicken Wings", n, BBQ, "BBQ sauce")),
  ...[6, 9, 12].map((n) => wings("Spicy Chicken Wings", n, SPICY, "hot sauce")),

  // Nachos
  { item: "Cheesy Nachos with Dip", lines: [["CC-CHIPS", 80], ["CC-CHEESESAUCE", 60]], method: "Serve the chips with warm cheese dip.", minutes: 4 },
  { item: "Loaded Veg Nachos", lines: [["CC-CHIPS", 90], ["CC-CHEESESAUCE", 50], ["CC-SALSA", 40], ["CC-CORN", 20], ["CC-CAPSICUM", 15], ["CC-ONION", 15], ["CC-JALAPENO", 10], ["CC-MAYO", 20]], method: "Load the chips with cheese sauce, salsa and the vegetables; finish with the creamy dressing.", minutes: 7 },
  { item: "Loaded Chicken Nachos", lines: [["CC-CHIPS", 90], ["CC-CHEESESAUCE", 50], ["CC-SALSA", 40], ["CC-CHICKEN", 60], ["CC-ONION", 15], ["CC-JALAPENO", 10], ["CC-CHILLI", 1], ["CC-MAYO", 20]], method: "Sauté spiced chicken, load the chips with it, cheese sauce and salsa; finish with the creamy dressing.", minutes: 10 },

  // All Things Pasta (dry pasta weight per portion)
  { item: "Veg Creamy Alfredo Pasta", lines: [["CC-PENNE", 100], ...ALFREDO, ...VEG_MIX], method: PASTA_METHOD("Alfredo"), minutes: 15, caveat: "The board does not name the pasta shape; penne assumed." },
  { item: "Veg Arrabita Penne", lines: [["CC-PENNE", 100], ...ARRABBIATA, ["CC-CAPSICUM", 20]], method: PASTA_METHOD("arrabbiata"), minutes: 15 },
  { item: "Veg Pink Sause Penne", lines: [["CC-PENNE", 100], ...PINK, ["CC-CAPSICUM", 20], ["CC-CORN", 20]], method: PASTA_METHOD("pink"), minutes: 15 },
  { item: "Veg Creamy Spaghetti", lines: [["CC-SPAGHETTI", 100], ...ALFREDO, ...VEG_MIX], method: PASTA_METHOD("cream"), minutes: 15 },
  { item: "Veg Arrabita Spaghetti", lines: [["CC-SPAGHETTI", 100], ...ARRABBIATA, ["CC-CAPSICUM", 20]], method: PASTA_METHOD("arrabbiata"), minutes: 15 },
  { item: "Veg Pink Sause Spaghetti", lines: [["CC-SPAGHETTI", 100], ...PINK, ["CC-CAPSICUM", 20], ["CC-CORN", 20]], method: PASTA_METHOD("pink"), minutes: 15 },
  { item: "Agli Olio Spaghetti Pasta", lines: [["CC-SPAGHETTI", 100], ["CC-OLIVEOIL", 25], ["CC-GARLIC", 10], ["CC-FLAKES", 2], ["CC-HERBS", 1], ["CC-SALT", 1]], method: "Boil the spaghetti, toss in olive oil with golden garlic and chilli flakes.", minutes: 12 },
  { item: "Chicken Arrabita Penne Chicken", lines: [["CC-PENNE", 100], ...ARRABBIATA, ...PASTA_CHICKEN], method: PASTA_METHOD("arrabbiata"), minutes: 18 },
  { item: "Creamy Alfredo Penne Chicken", lines: [["CC-PENNE", 100], ...ALFREDO, ...PASTA_CHICKEN], method: PASTA_METHOD("Alfredo"), minutes: 18 },
  { item: "Creamy Alfredo Spaghetti", lines: [["CC-SPAGHETTI", 100], ...ALFREDO, ...PASTA_CHICKEN], method: PASTA_METHOD("Alfredo"), minutes: 18, caveat: "Listed in the board's non-veg column; chicken assumed as the protein." },
  { item: "Chicken Pink Sause Spaghetti", lines: [["CC-SPAGHETTI", 100], ...PINK, ...PASTA_CHICKEN], method: PASTA_METHOD("pink"), minutes: 18 },

  // Thin Crust Pizzas (Regular)
  { item: "Classic Margherita Pizza", lines: [...PIZZA(80), ["CC-HERBS", 1]], method: PIZZA_METHOD, minutes: 12 },
  { item: "Simply Veg", lines: [...PIZZA(), ["CC-ONION", 20], ["CC-CAPSICUM", 20], ["CC-TOMATO", 20]], method: PIZZA_METHOD, minutes: 12 },
  { item: "Farmpizza", lines: [...PIZZA(), ["CC-ONION", 15], ["CC-CAPSICUM", 15], ["CC-TOMATO", 15], ["CC-MUSHROOM", 15], ["CC-CORN", 15], ["CC-OLIVES", 10]], method: PIZZA_METHOD, minutes: 12 },
  { item: "Corn Special", lines: [...PIZZA(), ["CC-CORN", 50]], method: PIZZA_METHOD, minutes: 12 },
  { item: "Onion and Paneer", lines: [...PIZZA(), ["CC-ONION", 30], ["CC-PANEER", 40]], method: PIZZA_METHOD, minutes: 12 },
  { item: "Peri Peri Mushroom Pizza", lines: [...PIZZA(), ["CC-MUSHROOM", 50], ["CC-PERIPERI", 3]], method: PIZZA_METHOD, minutes: 12 },
  { item: "Spicy Paneer Pizza", lines: [...PIZZA(), ["CC-PANEER", 50], ["CC-CAPSICUM", 15], ["CC-JALAPENO", 10], ["CC-CHILLI", 2]], method: PIZZA_METHOD, minutes: 12 },
  { item: "Tandoori Paneer Pizza", lines: [...PIZZA(), ["CC-PANEER", 50], ["CC-TANDOORI", 4], ["CC-CURD", 10], ["CC-ONION", 15], ["CC-CAPSICUM", 15]], method: PIZZA_METHOD, minutes: 14 },
  { item: "Simply Chicken", lines: [...PIZZA(), ["CC-CHICKEN", 60]], method: PIZZA_METHOD, minutes: 14 },
  { item: "BBQ Chicken Pizza", lines: [...PIZZA(), ["CC-CHICKEN", 60], ["CC-BBQ", 20], ["CC-ONION", 15]], method: PIZZA_METHOD, minutes: 14 },
  { item: "Chicken Tikka Pizza", lines: [...PIZZA(), ["CC-CHICKEN", 60], ["CC-TANDOORI", 4], ["CC-CURD", 10], ["CC-ONION", 15], ["CC-CAPSICUM", 15]], method: PIZZA_METHOD, minutes: 14 },
  { item: "Tandoori Chicken Pizza", lines: [...PIZZA(), ["CC-CHICKEN", 70], ["CC-TANDOORI", 5], ["CC-CURD", 10], ["CC-ONION", 15], ["CC-CAPSICUM", 15]], method: PIZZA_METHOD, minutes: 14 },
  { item: "Chicken Kheema Pizza", lines: [...PIZZA(), ["CC-CHICKMINCE", 70], ["CC-ONION", 20], ["CC-GGPASTE", 5], ["CC-CHILLI", 2]], method: PIZZA_METHOD, minutes: 15 },

  // Salads
  { item: "Paneer Tikka Salad", lines: [["CC-PANEER", 100], ["CC-TANDOORI", 4], ["CC-CURD", 20], ["CC-LETTUCE", 50], ["CC-CUCUMBER", 30], ["CC-TOMATO", 30], ["CC-ONION", 20], ["CC-LEMON", 5], ["CC-SALT", 1]], method: "Grill tandoori-marinated paneer and serve over the dressed greens.", minutes: 15 },
  { item: "Pasta Veg Salad", lines: [["CC-PENNE", 60], ["CC-LETTUCE", 30], ["CC-CUCUMBER", 30], ["CC-TOMATO", 30], ["CC-CORN", 20], ["CC-CAPSICUM", 20], ["CC-MAYO", 30], ["CC-HERBS", 1], ["CC-SALT", 1]], method: "Toss cooled pasta and vegetables in a creamy herb dressing.", minutes: 15 },
  { item: "Pasta & Herb Chicken", lines: [["CC-PENNE", 60], ["CC-CHICKEN", 100], ["CC-HERBS", 3], ["CC-GARLIC", 4], ["CC-OLIVEOIL", 10], ["CC-LETTUCE", 30], ["CC-TOMATO", 30], ["CC-SALT", 1]], method: "Grill herb-garlic chicken and serve over pasta and greens.", minutes: 18 },

  // Coders' Fried Combos: only the one whose contents the board prints.
  { item: "Chicken Popcorn + Fries Bucket", lines: [["CC-CHICKEN", 240], ["CC-MAIDA", 60], ["CC-CORNFLOUR", 30], ["CC-CRUMBS", 40], ["CC-EGG", 1], ["CC-PEPPER", 2], ["CC-SALT", 3], ["CC-FRIES", 180], ...FRY(110)], method: "A large popcorn chicken and a medium fries (as printed on the board), fried and packed together.", minutes: 15, caveat: "The board prints \"Large Popcorn + Med Fries\"; the Large / Medium portion weights are estimates." },
];

/** Menu items without a draft recipe, and why (the restaurant must supply the contents). */
export const NOT_COVERED: Array<{ item: string; reason: string }> = [
  { item: "Epic Savings 9 Pcs Fried", reason: "the combo's contents are not printed legibly on the boards" },
  { item: "All Chicken Box", reason: "the combo's description is cut off on the boards" },
  { item: "Boneless Hot Crispy Meal for 2", reason: "the combo's description is cut off on the boards" },
];

const UNITS: Record<UnitCode, { name: string; kind: "WEIGHT" | "VOLUME" | "COUNT" }> = {
  g: { name: "Gram", kind: "WEIGHT" },
  ml: { name: "Millilitre", kind: "VOLUME" },
  pc: { name: "Piece", kind: "COUNT" },
};

/** The recipe version's notes: everything a reader needs to see that this is an estimate. */
export function draftNotes(r: DraftRecipe): string {
  const ingredients = new Map(DRAFT_INGREDIENTS.map((i) => [i.sku, i]));
  const allergens = [...new Set(r.lines.flatMap(([sku]) => ingredients.get(sku)?.allergens ?? []))].sort();
  return [
    "ESTIMATED DRAFT (investor demo) — not Coders' Cafe's weighed recipe. Quantities are per Regular portion and must be confirmed by the kitchen before approval.",
    `Method (estimated): ${r.method}`,
    `Prep + cook time (estimated): about ${r.minutes} min.`,
    `Allergens: NOT verified.${allergens.length ? ` This draft's own ingredient list contains ${allergens.join(", ")}.` : ""} Never present any dish as allergen-free from this draft.`,
    ...(r.caveat ? [`Note: ${r.caveat}`] : []),
  ].join("\n");
}

export type DraftRecipeSeedResult = { created: number; existing: number; missingMenuItems: string[]; notCovered: number; materialsCreated: number };

/**
 * Add the draft recipes to the Coders' Cafe organization. Idempotent and
 * additive: existing units / materials (by code / SKU) are reused, a menu item
 * that already has a recipe is left alone, and no menu item is ever changed.
 */
export async function seedCodersCafeDraftRecipes(db: PrismaClient, ctx: AccessContext): Promise<DraftRecipeSeedResult> {
  const unitIds = new Map<UnitCode, string>();
  for (const code of Object.keys(UNITS) as UnitCode[]) {
    const found = await db.unit.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code } } });
    unitIds.set(code, found?.id ?? (await createUnit(ctx, { code, ...UNITS[code] }, db)).id);
  }
  const materialIds = new Map<string, string>();
  let materialsCreated = 0;
  for (const ing of DRAFT_INGREDIENTS) {
    const found = await db.material.findUnique({ where: { organizationId_sku: { organizationId: ctx.organizationId, sku: ing.sku } } });
    if (found) materialIds.set(ing.sku, found.id);
    else {
      materialIds.set(ing.sku, (await createMaterial(ctx, { sku: ing.sku, name: ing.name, baseUnitId: unitIds.get(ing.unit)! }, db)).id);
      materialsCreated++;
    }
  }
  const result: DraftRecipeSeedResult = { created: 0, existing: 0, missingMenuItems: [], notCovered: NOT_COVERED.length, materialsCreated };
  for (const r of DRAFT_RECIPES) {
    const item = await db.menuItem.findUnique({ where: { organizationId_name: { organizationId: ctx.organizationId, name: r.item } }, include: { recipe: { select: { id: true } } } });
    if (!item) {
      result.missingMenuItems.push(r.item);
      continue;
    }
    if (item.recipe) {
      result.existing++;
      continue;
    }
    await createRecipe(ctx, {
      name: r.item, outputType: "MENU_ITEM", menuItemId: item.id, estimated: true, notes: draftNotes(r),
      lines: r.lines.map(([sku, qty], i) => ({ componentType: "MATERIAL", materialId: materialIds.get(sku)!, qty, sortOrder: i })),
    }, db);
    result.created++;
  }
  return result;
}
