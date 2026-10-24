/**
 * RESTORA Demo Café — a SAMPLE Indian café dataset for demonstrating RESTORA
 * end to end (menu → POS / QR order → payment → kitchen → stock → food cost)
 * without depending on any real restaurant's data.
 *
 * Provenance: everything below was written for the demo. None of it is a real
 * café's menu, price list, recipe book or supplier quotation:
 *  - menu items and prices are plausible examples for an Indian café, not
 *    approved selling prices;
 *  - recipes and quantities are illustrative sample recipes, internally
 *    consistent with their yield, NOT chef-verified or weighed in a kitchen;
 *  - ingredient rates (₹ per base unit) are demo estimates used as opening-stock
 *    rates so recipe costing has something to show; they are not supplier prices;
 *  - suppliers are named "Demo … (sample)" so they cannot be mistaken for real
 *    vendors, and carry no phone, GSTIN or bank details;
 *  - allergens are NOT verified. A recipe's note lists only what its own sample
 *    ingredient list contains (milk, wheat (gluten)); nothing is called
 *    allergen-free;
 *  - tax: every item uses RESTORA's default 5 % (MenuItem.taxPct default, GST
 *    on restaurant service) — a documented demo configuration, not tax advice.
 *
 * docs/demo-cafe-data.md is the owner / chef review checklist for this data.
 * prisma/demo-cafe/seed.ts builds it; tests/db/demo-cafe-seed.test.ts checks it.
 */

export type BaseUnit = "kg" | "L" | "pc";
export type Allergen = "milk" | "wheat (gluten)";

export type DemoIngredient = {
  sku: string;
  name: string;
  category: string;
  unit: BaseUnit;
  /** Demo estimate, ₹ per base unit (posted as the opening-stock rate). Not a supplier price. */
  rate: number;
  /** Opening stock at the demo outlet, in the base unit. */
  opening: number;
  reorderLevel: number;
  perishable?: boolean;
  allergens?: Allergen[];
};

const MILK: Allergen[] = ["milk"];
const WHEAT: Allergen[] = ["wheat (gluten)"];

/**
 * Paneer opens BELOW its reorder level on purpose, so the low-stock list has
 * something to show from the first login.
 */
export const DEMO_INGREDIENTS: DemoIngredient[] = [
  { sku: "DEMO-MILK", name: "Milk (toned)", category: "Dairy", unit: "L", rate: 58, opening: 40, reorderLevel: 10, perishable: true, allergens: MILK },
  { sku: "DEMO-CURD", name: "Curd", category: "Dairy", unit: "kg", rate: 80, opening: 5, reorderLevel: 2, perishable: true, allergens: MILK },
  { sku: "DEMO-PANEER", name: "Paneer", category: "Dairy", unit: "kg", rate: 340, opening: 2, reorderLevel: 3, perishable: true, allergens: MILK },
  { sku: "DEMO-BUTTER", name: "Butter", category: "Dairy", unit: "kg", rate: 520, opening: 3, reorderLevel: 1, allergens: MILK },
  { sku: "DEMO-CREAM", name: "Fresh cream", category: "Dairy", unit: "L", rate: 220, opening: 2, reorderLevel: 0.5, perishable: true, allergens: MILK },
  { sku: "DEMO-GHEE", name: "Ghee", category: "Dairy", unit: "kg", rate: 650, opening: 2, reorderLevel: 0.5, allergens: MILK },
  { sku: "DEMO-CHEESE", name: "Processed cheese", category: "Dairy", unit: "kg", rate: 450, opening: 1, reorderLevel: 0.3, allergens: MILK },
  { sku: "DEMO-TEA", name: "Tea leaves (CTC)", category: "Beverages", unit: "kg", rate: 400, opening: 2, reorderLevel: 0.5 },
  { sku: "DEMO-CHAIMASALA", name: "Chai masala", category: "Beverages", unit: "kg", rate: 900, opening: 0.5, reorderLevel: 0.1 },
  { sku: "DEMO-FILTERCOFFEE", name: "Filter coffee powder", category: "Beverages", unit: "kg", rate: 700, opening: 2, reorderLevel: 0.5 },
  { sku: "DEMO-ESPRESSO", name: "Espresso coffee beans", category: "Beverages", unit: "kg", rate: 1200, opening: 1.5, reorderLevel: 0.5 },
  { sku: "DEMO-SUGAR", name: "Sugar", category: "Grains & flours", unit: "kg", rate: 45, opening: 15, reorderLevel: 5 },
  { sku: "DEMO-RICE", name: "Basmati rice", category: "Grains & flours", unit: "kg", rate: 110, opening: 20, reorderLevel: 5 },
  { sku: "DEMO-BATTER", name: "Idli-dosa batter", category: "Grains & flours", unit: "kg", rate: 60, opening: 10, reorderLevel: 3, perishable: true },
  { sku: "DEMO-MAIDA", name: "Refined flour (maida)", category: "Grains & flours", unit: "kg", rate: 45, opening: 8, reorderLevel: 2, allergens: WHEAT },
  { sku: "DEMO-BREAD", name: "Sandwich bread (slice)", category: "Grains & flours", unit: "pc", rate: 3, opening: 120, reorderLevel: 40, perishable: true, allergens: WHEAT },
  { sku: "DEMO-BUN", name: "Burger bun", category: "Grains & flours", unit: "pc", rate: 8, opening: 40, reorderLevel: 12, perishable: true, allergens: WHEAT },
  { sku: "DEMO-WRAP", name: "Wheat wrap (tortilla)", category: "Grains & flours", unit: "pc", rate: 10, opening: 30, reorderLevel: 10, perishable: true, allergens: WHEAT },
  { sku: "DEMO-JAMUNMIX", name: "Gulab jamun mix", category: "Grains & flours", unit: "kg", rate: 260, opening: 2, reorderLevel: 0.5, allergens: [...MILK, ...WHEAT] },
  { sku: "DEMO-TOORDAL", name: "Toor dal", category: "Pulses", unit: "kg", rate: 140, opening: 8, reorderLevel: 2 },
  { sku: "DEMO-ONION", name: "Onion", category: "Vegetables", unit: "kg", rate: 35, opening: 20, reorderLevel: 5, perishable: true },
  { sku: "DEMO-TOMATO", name: "Tomato", category: "Vegetables", unit: "kg", rate: 40, opening: 15, reorderLevel: 5, perishable: true },
  { sku: "DEMO-POTATO", name: "Potato", category: "Vegetables", unit: "kg", rate: 30, opening: 15, reorderLevel: 5, perishable: true },
  { sku: "DEMO-CAPSICUM", name: "Capsicum", category: "Vegetables", unit: "kg", rate: 80, opening: 3, reorderLevel: 1, perishable: true },
  { sku: "DEMO-CUCUMBER", name: "Cucumber", category: "Vegetables", unit: "kg", rate: 40, opening: 3, reorderLevel: 1, perishable: true },
  { sku: "DEMO-MIXVEG", name: "Mixed vegetables (carrot, beans, peas)", category: "Vegetables", unit: "kg", rate: 60, opening: 8, reorderLevel: 2, perishable: true },
  { sku: "DEMO-CORIANDER", name: "Coriander leaves", category: "Vegetables", unit: "kg", rate: 80, opening: 0.5, reorderLevel: 0.2, perishable: true },
  { sku: "DEMO-GGPASTE", name: "Ginger-garlic paste", category: "Vegetables", unit: "kg", rate: 150, opening: 2, reorderLevel: 0.5, perishable: true },
  { sku: "DEMO-LEMON", name: "Lemon", category: "Vegetables", unit: "pc", rate: 5, opening: 60, reorderLevel: 20, perishable: true },
  { sku: "DEMO-FRIES", name: "Frozen french fries", category: "Frozen", unit: "kg", rate: 180, opening: 5, reorderLevel: 1.5 },
  { sku: "DEMO-KETCHUP", name: "Tomato ketchup", category: "Sauces", unit: "kg", rate: 120, opening: 2, reorderLevel: 0.5 },
  { sku: "DEMO-OIL", name: "Cooking oil (refined)", category: "Oils", unit: "L", rate: 150, opening: 10, reorderLevel: 3 },
  { sku: "DEMO-SALT", name: "Salt", category: "Spices", unit: "kg", rate: 22, opening: 5, reorderLevel: 1 },
  { sku: "DEMO-CUMIN", name: "Cumin seeds", category: "Spices", unit: "kg", rate: 400, opening: 1, reorderLevel: 0.2 },
  { sku: "DEMO-MUSTARD", name: "Mustard seeds", category: "Spices", unit: "kg", rate: 160, opening: 0.5, reorderLevel: 0.1 },
  { sku: "DEMO-TURMERIC", name: "Turmeric powder", category: "Spices", unit: "kg", rate: 280, opening: 0.5, reorderLevel: 0.1 },
  { sku: "DEMO-CHILLI", name: "Red chilli powder", category: "Spices", unit: "kg", rate: 320, opening: 0.5, reorderLevel: 0.1 },
  { sku: "DEMO-GARAM", name: "Garam masala", category: "Spices", unit: "kg", rate: 700, opening: 0.5, reorderLevel: 0.1 },
  { sku: "DEMO-SAMBARPOWDER", name: "Sambar powder", category: "Spices", unit: "kg", rate: 450, opening: 0.5, reorderLevel: 0.1 },
  { sku: "DEMO-TAMARIND", name: "Tamarind", category: "Spices", unit: "kg", rate: 180, opening: 1, reorderLevel: 0.2 },
];

/** The sambar sub-recipe's output (made to order: dishes explode through it, so it holds no stock and no rate). */
export const DEMO_PREPARED = { sku: "DEMO-SAMBAR", name: "Sambar (prepared)", category: "Prepared", unit: "kg" as const };

export type DemoVariant = { name: string; priceDelta: number; consumptionFactor: number };
export type DemoItem = {
  posCode: string;
  name: string;
  category: string;
  /** ₹, sample price — not an approved selling price. */
  price: number;
  isVeg: boolean;
  station: "KITCHEN" | "BAR";
  description: string;
  variants?: DemoVariant[];
  modifiers?: string[];
};

export const DEMO_CATEGORIES = ["Hot Beverages", "Cold Beverages", "Breakfast", "Snacks", "Burgers & Wraps", "Starters", "Main Course", "Rice & Biryani", "Breads", "Desserts"] as const;

const LARGE: DemoVariant = { name: "Large", priceDelta: 20, consumptionFactor: 1.5 };

export const DEMO_MENU: DemoItem[] = [
  { posCode: "DEMO-101", name: "Masala Chai", category: "Hot Beverages", price: 30, isVeg: true, station: "BAR", description: "Milk tea brewed with chai masala.", variants: [{ ...LARGE, priceDelta: 15 }], modifiers: ["Sugar level"] },
  { posCode: "DEMO-102", name: "Filter Coffee", category: "Hot Beverages", price: 40, isVeg: true, station: "BAR", description: "South Indian decoction coffee with hot milk.", modifiers: ["Sugar level"] },
  { posCode: "DEMO-103", name: "Cappuccino", category: "Hot Beverages", price: 120, isVeg: true, station: "BAR", description: "Espresso with steamed, foamed milk.", variants: [{ ...LARGE, priceDelta: 30 }], modifiers: ["Sugar level", "Coffee add-ons"] },
  { posCode: "DEMO-105", name: "Espresso", category: "Hot Beverages", price: 80, isVeg: true, station: "BAR", description: "A single short shot of espresso.", modifiers: ["Coffee add-ons"] },
  { posCode: "DEMO-106", name: "Americano", category: "Hot Beverages", price: 110, isVeg: true, station: "BAR", description: "A double espresso topped up with hot water.", modifiers: ["Sugar level", "Coffee add-ons"] },
  { posCode: "DEMO-107", name: "Café Latte", category: "Hot Beverages", price: 140, isVeg: true, station: "BAR", description: "Espresso with plenty of steamed milk.", variants: [{ ...LARGE, priceDelta: 30 }], modifiers: ["Sugar level", "Coffee add-ons"] },
  { posCode: "DEMO-104", name: "Hot Chocolate", category: "Hot Beverages", price: 140, isVeg: true, station: "BAR", description: "Cocoa and hot milk." },
  { posCode: "DEMO-201", name: "Cold Coffee", category: "Cold Beverages", price: 150, isVeg: true, station: "BAR", description: "Chilled coffee blended with milk and cream.", modifiers: ["Sugar level", "Coffee add-ons"] },
  { posCode: "DEMO-202", name: "Fresh Lime Soda", category: "Cold Beverages", price: 70, isVeg: true, station: "BAR", description: "Lime and soda, sweet or salted.", modifiers: ["Lime soda style"] },
  { posCode: "DEMO-203", name: "Mango Lassi", category: "Cold Beverages", price: 110, isVeg: true, station: "BAR", description: "Sweet curd drink with mango pulp." },
  { posCode: "DEMO-204", name: "Masala Chaas", category: "Cold Beverages", price: 50, isVeg: true, station: "BAR", description: "Spiced buttermilk." },
  { posCode: "DEMO-205", name: "Lemon Iced Tea", category: "Cold Beverages", price: 90, isVeg: true, station: "BAR", description: "Chilled black tea with fresh lemon.", modifiers: ["Sugar level"] },
  { posCode: "DEMO-301", name: "Masala Dosa", category: "Breakfast", price: 110, isVeg: true, station: "KITCHEN", description: "Crisp dosa with potato masala, served with sambar." },
  { posCode: "DEMO-302", name: "Idli Sambar (2 pc)", category: "Breakfast", price: 70, isVeg: true, station: "KITCHEN", description: "Steamed rice cakes with sambar." },
  { posCode: "DEMO-303", name: "Medu Vada (2 pc)", category: "Breakfast", price: 80, isVeg: true, station: "KITCHEN", description: "Fried lentil fritters." },
  { posCode: "DEMO-304", name: "Poha", category: "Breakfast", price: 70, isVeg: true, station: "KITCHEN", description: "Flattened rice with onion and peanuts." },
  { posCode: "DEMO-305", name: "Aloo Paratha", category: "Breakfast", price: 90, isVeg: true, station: "KITCHEN", description: "Wheat flatbread stuffed with spiced potato." },
  { posCode: "DEMO-401", name: "Veg Sandwich", category: "Snacks", price: 90, isVeg: true, station: "KITCHEN", description: "Grilled sandwich with potato, cucumber and tomato.", modifiers: ["Sandwich add-ons"] },
  { posCode: "DEMO-402", name: "Samosa (2 pc)", category: "Snacks", price: 50, isVeg: true, station: "KITCHEN", description: "Pastry filled with spiced potato." },
  { posCode: "DEMO-403", name: "Pav Bhaji", category: "Snacks", price: 130, isVeg: true, station: "KITCHEN", description: "Mashed vegetable curry with buttered buns." },
  { posCode: "DEMO-451", name: "Veg Burger", category: "Burgers & Wraps", price: 130, isVeg: true, station: "KITCHEN", description: "Crisp potato-vegetable patty in a toasted bun with onion, tomato and ketchup.", modifiers: ["Sandwich add-ons"] },
  { posCode: "DEMO-452", name: "Paneer Wrap", category: "Burgers & Wraps", price: 170, isVeg: true, station: "KITCHEN", description: "Spiced paneer, capsicum and onion rolled in a wheat wrap.", modifiers: ["Spice level"] },
  { posCode: "DEMO-453", name: "French Fries", category: "Burgers & Wraps", price: 110, isVeg: true, station: "KITCHEN", description: "Salted fries with ketchup." },
  { posCode: "DEMO-501", name: "Paneer Tikka", category: "Starters", price: 260, isVeg: true, station: "KITCHEN", description: "Marinated paneer, capsicum and onion from the tandoor.", modifiers: ["Spice level"] },
  { posCode: "DEMO-502", name: "Gobi 65", category: "Starters", price: 180, isVeg: true, station: "KITCHEN", description: "Spiced fried cauliflower.", modifiers: ["Spice level"] },
  { posCode: "DEMO-503", name: "Veg Manchurian", category: "Starters", price: 190, isVeg: true, station: "KITCHEN", description: "Vegetable dumplings in a soy-garlic sauce.", modifiers: ["Spice level"] },
  { posCode: "DEMO-504", name: "Chicken Tikka", category: "Starters", price: 300, isVeg: false, station: "KITCHEN", description: "Marinated chicken from the tandoor.", modifiers: ["Spice level"] },
  { posCode: "DEMO-601", name: "Paneer Butter Masala", category: "Main Course", price: 260, isVeg: true, station: "KITCHEN", description: "Paneer in a tomato, butter and cream gravy.", modifiers: ["Spice level", "Curry add-ons"] },
  { posCode: "DEMO-602", name: "Dal Tadka", category: "Main Course", price: 180, isVeg: true, station: "KITCHEN", description: "Toor dal tempered with cumin and ghee.", modifiers: ["Spice level"] },
  { posCode: "DEMO-603", name: "Chana Masala", category: "Main Course", price: 190, isVeg: true, station: "KITCHEN", description: "Chickpeas in an onion-tomato gravy.", modifiers: ["Spice level"] },
  { posCode: "DEMO-604", name: "Veg Kolhapuri", category: "Main Course", price: 210, isVeg: true, station: "KITCHEN", description: "Mixed vegetables in a spicy Kolhapuri gravy.", modifiers: ["Spice level"] },
  { posCode: "DEMO-701", name: "Veg Biryani", category: "Rice & Biryani", price: 220, isVeg: true, station: "KITCHEN", description: "Basmati rice layered with spiced vegetables.", modifiers: ["Spice level"] },
  { posCode: "DEMO-702", name: "Chicken Biryani", category: "Rice & Biryani", price: 290, isVeg: false, station: "KITCHEN", description: "Basmati rice layered with spiced chicken.", modifiers: ["Spice level"] },
  { posCode: "DEMO-703", name: "Jeera Rice", category: "Rice & Biryani", price: 150, isVeg: true, station: "KITCHEN", description: "Basmati rice with cumin and ghee." },
  { posCode: "DEMO-704", name: "Curd Rice", category: "Rice & Biryani", price: 130, isVeg: true, station: "KITCHEN", description: "Rice mixed with curd and a mustard tempering." },
  { posCode: "DEMO-801", name: "Butter Naan", category: "Breads", price: 50, isVeg: true, station: "KITCHEN", description: "Leavened flatbread with butter." },
  { posCode: "DEMO-802", name: "Tandoori Roti", category: "Breads", price: 30, isVeg: true, station: "KITCHEN", description: "Whole-wheat flatbread from the tandoor." },
  { posCode: "DEMO-803", name: "Garlic Naan", category: "Breads", price: 70, isVeg: true, station: "KITCHEN", description: "Naan topped with garlic and coriander." },
  { posCode: "DEMO-901", name: "Gulab Jamun (2 pc)", category: "Desserts", price: 80, isVeg: true, station: "KITCHEN", description: "Fried milk dumplings in sugar syrup." },
  { posCode: "DEMO-902", name: "Rasmalai (2 pc)", category: "Desserts", price: 110, isVeg: true, station: "KITCHEN", description: "Soft cheese dumplings in sweetened milk." },
];

export type DemoOption = { name: string; priceDelta?: number; material?: { sku: string; qty: number } };
export type DemoModifierGroup = { name: string; minSelect: number; maxSelect: number; options: DemoOption[] };

/** Only "Coffee add-ons" → Extra shot, "Sandwich add-ons" → Extra cheese and "Curry add-ons" → Extra paneer move stock (per unit ordered, base unit). */
export const DEMO_MODIFIER_GROUPS: DemoModifierGroup[] = [
  { name: "Sugar level", minSelect: 0, maxSelect: 1, options: [{ name: "Less sugar" }, { name: "No sugar" }] },
  { name: "Spice level", minSelect: 0, maxSelect: 1, options: [{ name: "Mild" }, { name: "Medium" }, { name: "Spicy" }] },
  { name: "Lime soda style", minSelect: 0, maxSelect: 1, options: [{ name: "Sweet" }, { name: "Salted" }, { name: "Sweet & salted" }] },
  { name: "Coffee add-ons", minSelect: 0, maxSelect: 1, options: [{ name: "Extra shot", priceDelta: 30, material: { sku: "DEMO-ESPRESSO", qty: 0.009 } }] },
  { name: "Sandwich add-ons", minSelect: 0, maxSelect: 1, options: [{ name: "Extra cheese", priceDelta: 30, material: { sku: "DEMO-CHEESE", qty: 0.02 } }] },
  { name: "Curry add-ons", minSelect: 0, maxSelect: 1, options: [{ name: "Extra paneer", priceDelta: 60, material: { sku: "DEMO-PANEER", qty: 0.05 } }] },
];

/** A recipe line: an ingredient (base unit) or the sambar sub-recipe (kg of prepared sambar). */
export type DemoLine = { sku: string; qty: number } | { sub: "Sambar"; qty: number };
export type DemoRecipe = { item: string; yield: number; lines: DemoLine[]; method: string };

/**
 * Sample sub-recipe: one batch of sambar (2 kg with the water, which is not
 * stocked). Dishes use it in kg, so 0.15 kg on a plate is 0.075 of a batch.
 */
export const DEMO_SAMBAR = {
  name: "Sambar",
  yieldKg: 2,
  lines: [
    { sku: "DEMO-TOORDAL", qty: 0.15 }, { sku: "DEMO-MIXVEG", qty: 0.3 }, { sku: "DEMO-TOMATO", qty: 0.2 }, { sku: "DEMO-ONION", qty: 0.15 },
    { sku: "DEMO-TAMARIND", qty: 0.03 }, { sku: "DEMO-SAMBARPOWDER", qty: 0.03 }, { sku: "DEMO-OIL", qty: 0.03 }, { sku: "DEMO-MUSTARD", qty: 0.005 },
    { sku: "DEMO-TURMERIC", qty: 0.003 }, { sku: "DEMO-SALT", qty: 0.02 },
  ] as Array<{ sku: string; qty: number }>,
  method: "Pressure-cook the dal with turmeric. Cook the vegetables, tomato and onion with tamarind water and sambar powder, add the dal, simmer, temper with mustard in oil.",
};

/**
 * Sample recipes, one serving each (yield 1 pc). Quantities are in the
 * ingredient's base unit (kg / L / pc). Water and ice are not stocked.
 * Items without a recipe here (e.g. Hot Chocolate, Samosa) are recorded by
 * RESTORA as unmapped sales when sold, which the demo also shows.
 */
export const DEMO_RECIPES: DemoRecipe[] = [
  { item: "Masala Chai", yield: 1, lines: [{ sku: "DEMO-MILK", qty: 0.1 }, { sku: "DEMO-TEA", qty: 0.004 }, { sku: "DEMO-SUGAR", qty: 0.012 }, { sku: "DEMO-CHAIMASALA", qty: 0.0005 }], method: "Boil water with tea and chai masala, add milk and sugar, simmer and strain (150 ml)." },
  { item: "Filter Coffee", yield: 1, lines: [{ sku: "DEMO-MILK", qty: 0.1 }, { sku: "DEMO-FILTERCOFFEE", qty: 0.01 }, { sku: "DEMO-SUGAR", qty: 0.01 }], method: "Brew decoction in a filter; mix with hot milk and sugar (150 ml)." },
  { item: "Cappuccino", yield: 1, lines: [{ sku: "DEMO-ESPRESSO", qty: 0.018 }, { sku: "DEMO-MILK", qty: 0.15 }, { sku: "DEMO-SUGAR", qty: 0.008 }], method: "Pull a double shot; steam and foam the milk; pour (180 ml)." },
  { item: "Cold Coffee", yield: 1, lines: [{ sku: "DEMO-ESPRESSO", qty: 0.016 }, { sku: "DEMO-MILK", qty: 0.25 }, { sku: "DEMO-SUGAR", qty: 0.025 }, { sku: "DEMO-CREAM", qty: 0.02 }], method: "Blend chilled espresso with milk, sugar, cream and ice (300 ml)." },
  { item: "Masala Dosa", yield: 1, lines: [{ sku: "DEMO-BATTER", qty: 0.15 }, { sku: "DEMO-POTATO", qty: 0.12 }, { sku: "DEMO-ONION", qty: 0.03 }, { sku: "DEMO-OIL", qty: 0.015 }, { sku: "DEMO-MUSTARD", qty: 0.001 }, { sku: "DEMO-TURMERIC", qty: 0.001 }, { sku: "DEMO-SALT", qty: 0.003 }, { sub: "Sambar", qty: 0.15 }], method: "Spread the batter on a hot tawa with oil; fill with the potato-onion masala; serve with sambar." },
  { item: "Idli Sambar (2 pc)", yield: 1, lines: [{ sku: "DEMO-BATTER", qty: 0.16 }, { sku: "DEMO-SALT", qty: 0.001 }, { sub: "Sambar", qty: 0.2 }], method: "Steam two idlis (80 g batter each); serve with sambar." },
  { item: "Veg Sandwich", yield: 1, lines: [{ sku: "DEMO-BREAD", qty: 2 }, { sku: "DEMO-BUTTER", qty: 0.01 }, { sku: "DEMO-POTATO", qty: 0.05 }, { sku: "DEMO-CUCUMBER", qty: 0.03 }, { sku: "DEMO-TOMATO", qty: 0.03 }, { sku: "DEMO-ONION", qty: 0.02 }, { sku: "DEMO-SALT", qty: 0.001 }], method: "Butter the slices, layer boiled potato, cucumber, tomato and onion, grill." },
  { item: "Paneer Tikka", yield: 1, lines: [{ sku: "DEMO-PANEER", qty: 0.18 }, { sku: "DEMO-CURD", qty: 0.05 }, { sku: "DEMO-CAPSICUM", qty: 0.04 }, { sku: "DEMO-ONION", qty: 0.04 }, { sku: "DEMO-GGPASTE", qty: 0.01 }, { sku: "DEMO-CHILLI", qty: 0.004 }, { sku: "DEMO-GARAM", qty: 0.002 }, { sku: "DEMO-OIL", qty: 0.015 }, { sku: "DEMO-SALT", qty: 0.003 }], method: "Marinate paneer and vegetables in spiced curd; skewer and roast (6 pieces)." },
  { item: "Paneer Butter Masala", yield: 1, lines: [{ sku: "DEMO-PANEER", qty: 0.15 }, { sku: "DEMO-TOMATO", qty: 0.15 }, { sku: "DEMO-ONION", qty: 0.05 }, { sku: "DEMO-BUTTER", qty: 0.02 }, { sku: "DEMO-CREAM", qty: 0.03 }, { sku: "DEMO-GGPASTE", qty: 0.01 }, { sku: "DEMO-CHILLI", qty: 0.004 }, { sku: "DEMO-GARAM", qty: 0.002 }, { sku: "DEMO-SALT", qty: 0.004 }], method: "Cook onion, tomato and ginger-garlic in butter; blend; simmer with spices, add paneer and cream." },
  { item: "Dal Tadka", yield: 1, lines: [{ sku: "DEMO-TOORDAL", qty: 0.08 }, { sku: "DEMO-TOMATO", qty: 0.05 }, { sku: "DEMO-ONION", qty: 0.04 }, { sku: "DEMO-GHEE", qty: 0.015 }, { sku: "DEMO-CUMIN", qty: 0.002 }, { sku: "DEMO-TURMERIC", qty: 0.002 }, { sku: "DEMO-CHILLI", qty: 0.002 }, { sku: "DEMO-GGPASTE", qty: 0.005 }, { sku: "DEMO-SALT", qty: 0.004 }], method: "Pressure-cook the dal with turmeric; temper with cumin, onion, tomato and ginger-garlic in ghee." },
  { item: "Veg Biryani", yield: 1, lines: [{ sku: "DEMO-RICE", qty: 0.15 }, { sku: "DEMO-MIXVEG", qty: 0.12 }, { sku: "DEMO-ONION", qty: 0.06 }, { sku: "DEMO-CURD", qty: 0.04 }, { sku: "DEMO-GHEE", qty: 0.015 }, { sku: "DEMO-OIL", qty: 0.01 }, { sku: "DEMO-GARAM", qty: 0.004 }, { sku: "DEMO-GGPASTE", qty: 0.01 }, { sku: "DEMO-CORIANDER", qty: 0.005 }, { sku: "DEMO-SALT", qty: 0.005 }], method: "Par-boil the rice; cook the vegetables in spiced curd; layer and finish on dum." },
  { item: "Jeera Rice", yield: 1, lines: [{ sku: "DEMO-RICE", qty: 0.12 }, { sku: "DEMO-GHEE", qty: 0.01 }, { sku: "DEMO-CUMIN", qty: 0.003 }, { sku: "DEMO-SALT", qty: 0.003 }], method: "Temper cumin in ghee; add the soaked rice and water; cook covered." },
  { item: "Butter Naan", yield: 1, lines: [{ sku: "DEMO-MAIDA", qty: 0.09 }, { sku: "DEMO-CURD", qty: 0.015 }, { sku: "DEMO-BUTTER", qty: 0.01 }, { sku: "DEMO-OIL", qty: 0.003 }, { sku: "DEMO-SUGAR", qty: 0.002 }, { sku: "DEMO-SALT", qty: 0.002 }], method: "Knead a soft dough with curd; rest; roll and bake in the tandoor; brush with butter." },
  { item: "Espresso", yield: 1, lines: [{ sku: "DEMO-ESPRESSO", qty: 0.009 }], method: "Pull a single 30 ml shot." },
  { item: "Americano", yield: 1, lines: [{ sku: "DEMO-ESPRESSO", qty: 0.018 }], method: "Pull a double shot over hot water (200 ml)." },
  { item: "Café Latte", yield: 1, lines: [{ sku: "DEMO-ESPRESSO", qty: 0.018 }, { sku: "DEMO-MILK", qty: 0.2 }, { sku: "DEMO-SUGAR", qty: 0.008 }], method: "Pull a double shot; steam the milk with a thin foam; pour (240 ml)." },
  { item: "Lemon Iced Tea", yield: 1, lines: [{ sku: "DEMO-TEA", qty: 0.003 }, { sku: "DEMO-SUGAR", qty: 0.025 }, { sku: "DEMO-LEMON", qty: 1 }], method: "Brew strong tea, sweeten, cool; add the juice of one lemon and ice (300 ml)." },
  { item: "Fresh Lime Soda", yield: 1, lines: [{ sku: "DEMO-LEMON", qty: 1 }, { sku: "DEMO-SUGAR", qty: 0.02 }, { sku: "DEMO-SALT", qty: 0.001 }], method: "Juice one lemon; add sugar and / or salt to the chosen style; top up with soda (soda not stocked)." },
  { item: "Masala Chaas", yield: 1, lines: [{ sku: "DEMO-CURD", qty: 0.1 }, { sku: "DEMO-CUMIN", qty: 0.001 }, { sku: "DEMO-CORIANDER", qty: 0.003 }, { sku: "DEMO-SALT", qty: 0.002 }], method: "Whisk curd with water, roasted cumin, coriander and salt (250 ml)." },
  { item: "Veg Burger", yield: 1, lines: [{ sku: "DEMO-BUN", qty: 1 }, { sku: "DEMO-POTATO", qty: 0.06 }, { sku: "DEMO-MIXVEG", qty: 0.04 }, { sku: "DEMO-MAIDA", qty: 0.01 }, { sku: "DEMO-OIL", qty: 0.02 }, { sku: "DEMO-ONION", qty: 0.02 }, { sku: "DEMO-TOMATO", qty: 0.02 }, { sku: "DEMO-KETCHUP", qty: 0.015 }, { sku: "DEMO-SALT", qty: 0.002 }], method: "Shape a patty of mashed potato and vegetables bound with maida; shallow-fry; build in the toasted bun with onion, tomato and ketchup." },
  { item: "Paneer Wrap", yield: 1, lines: [{ sku: "DEMO-WRAP", qty: 1 }, { sku: "DEMO-PANEER", qty: 0.08 }, { sku: "DEMO-CAPSICUM", qty: 0.03 }, { sku: "DEMO-ONION", qty: 0.03 }, { sku: "DEMO-OIL", qty: 0.01 }, { sku: "DEMO-CHILLI", qty: 0.002 }, { sku: "DEMO-GARAM", qty: 0.001 }, { sku: "DEMO-KETCHUP", qty: 0.015 }, { sku: "DEMO-SALT", qty: 0.002 }], method: "Toss paneer, capsicum and onion with the spices in oil; roll in the warmed wrap with ketchup." },
  { item: "French Fries", yield: 1, lines: [{ sku: "DEMO-FRIES", qty: 0.15 }, { sku: "DEMO-OIL", qty: 0.02 }, { sku: "DEMO-SALT", qty: 0.002 }, { sku: "DEMO-KETCHUP", qty: 0.02 }], method: "Deep-fry from frozen until golden; salt; serve with ketchup (150 g)." },
  { item: "Curd Rice", yield: 1, lines: [{ sku: "DEMO-RICE", qty: 0.08 }, { sku: "DEMO-CURD", qty: 0.1 }, { sku: "DEMO-OIL", qty: 0.005 }, { sku: "DEMO-MUSTARD", qty: 0.001 }, { sku: "DEMO-CORIANDER", qty: 0.002 }, { sku: "DEMO-SALT", qty: 0.002 }], method: "Cook the rice soft, cool, mix with curd and salt; temper with mustard in oil; garnish." },
  { item: "Garlic Naan", yield: 1, lines: [{ sku: "DEMO-MAIDA", qty: 0.09 }, { sku: "DEMO-CURD", qty: 0.015 }, { sku: "DEMO-BUTTER", qty: 0.01 }, { sku: "DEMO-GGPASTE", qty: 0.005 }, { sku: "DEMO-CORIANDER", qty: 0.002 }, { sku: "DEMO-SALT", qty: 0.002 }], method: "As butter naan; top with garlic and coriander before baking; brush with butter." },
  { item: "Gulab Jamun (2 pc)", yield: 1, lines: [{ sku: "DEMO-JAMUNMIX", qty: 0.05 }, { sku: "DEMO-MILK", qty: 0.015 }, { sku: "DEMO-SUGAR", qty: 0.06 }, { sku: "DEMO-OIL", qty: 0.01 }], method: "Knead the mix with milk, shape two balls, fry slowly, soak in sugar syrup." },
];

export const DEMO_SUPPLIERS = [
  { name: "Demo Dairy Supplier (sample)", category: "Dairy", skus: DEMO_INGREDIENTS.filter((i) => i.category === "Dairy").map((i) => i.sku) },
  { name: "Demo Produce Supplier (sample)", category: "Vegetables", skus: DEMO_INGREDIENTS.filter((i) => i.category === "Vegetables").map((i) => i.sku) },
  { name: "Demo Dry Goods Supplier (sample)", category: "Dry goods", skus: DEMO_INGREDIENTS.filter((i) => !["Dairy", "Vegetables"].includes(i.category)).map((i) => i.sku) },
] as const;
