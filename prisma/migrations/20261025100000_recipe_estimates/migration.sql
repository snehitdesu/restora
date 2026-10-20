-- Recipe versions whose quantities are estimates (not the kitchen's verified weights). Additive:
-- one NOT NULL column with a default; every existing version is false (unchanged behaviour).

-- AlterTable
ALTER TABLE "RecipeVersion" ADD COLUMN "estimated" BOOLEAN NOT NULL DEFAULT false;
