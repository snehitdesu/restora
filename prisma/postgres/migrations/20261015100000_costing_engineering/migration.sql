-- Group 4: costing and menu engineering. Additive only;
-- mirrors prisma/migrations/20261015100000_costing_engineering.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "unitCost" DECIMAL(16,6),
ADD COLUMN     "lineCost" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "RecipeVersion" ADD COLUMN     "overheadPct" DECIMAL(7,4) NOT NULL DEFAULT 0;
