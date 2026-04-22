ALTER TABLE "rooms" ADD COLUMN "rollMode" TEXT NOT NULL DEFAULT 'manual_input';
ALTER TABLE "rooms" ADD COLUMN "statGenerationMode" TEXT NOT NULL DEFAULT 'standard_array';
ALTER TABLE "game_sessions" ADD COLUMN "currentSceneJson" TEXT;

UPDATE "turns" SET "status" = 'action_waiting' WHERE "status" = 'action-submission';
UPDATE "turns" SET "status" = 'roll_waiting' WHERE "status" = 'roll-waiting';
UPDATE "rooms" SET "gameStatus" = 'in_progress' WHERE "gameStatus" = 'in-progress';
