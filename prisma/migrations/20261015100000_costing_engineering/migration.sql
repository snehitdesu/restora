-- Group 4: costing and menu engineering (docs/group4-implementation-map.md). Additive only.

-- Recipe cost of one standard portion, frozen when a sale consumes stock (historical plate cost),
-- and everything the line consumed (variant scaling + add-ons) at those costs.
ALTER TABLE "OrderItem" ADD COLUMN "unitCost" DECIMAL;
ALTER TABLE "OrderItem" ADD COLUMN "lineCost" DECIMAL;

-- Overhead % per recipe version (plate cost = ingredients x (1 + overhead %)).
ALTER TABLE "RecipeVersion" ADD COLUMN "overheadPct" DECIMAL NOT NULL DEFAULT 0;
