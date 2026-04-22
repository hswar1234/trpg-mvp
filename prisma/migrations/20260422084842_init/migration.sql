-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "scenarioTheme" TEXT NOT NULL,
    "llmModel" TEXT NOT NULL DEFAULT 'gpt-4-turbo',
    "ruleset" TEXT NOT NULL DEFAULT 'd20-basic',
    "maxPlayers" INTEGER NOT NULL DEFAULT 4,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "password" TEXT,
    "turnMode" TEXT NOT NULL DEFAULT 'simultaneous',
    "hostId" TEXT NOT NULL,
    "gameStatus" TEXT NOT NULL DEFAULT 'waiting',
    "currentTurnId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "room_players" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "isHost" BOOLEAN NOT NULL DEFAULT false,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "room_players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "room_players_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "characters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomPlayerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "hp" INTEGER NOT NULL DEFAULT 10,
    "maxHp" INTEGER NOT NULL DEFAULT 10,
    "mp" INTEGER NOT NULL DEFAULT 5,
    "maxMp" INTEGER NOT NULL DEFAULT 5,
    "strength" INTEGER NOT NULL DEFAULT 10,
    "dexterity" INTEGER NOT NULL DEFAULT 10,
    "intelligence" INTEGER NOT NULL DEFAULT 10,
    "charisma" INTEGER NOT NULL DEFAULT 10,
    "constitution" INTEGER NOT NULL DEFAULT 10,
    "wisdom" INTEGER NOT NULL DEFAULT 10,
    "skills" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "characters_roomPlayerId_fkey" FOREIGN KEY ("roomPlayerId") REFERENCES "room_players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "game_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "sceneNumber" INTEGER NOT NULL DEFAULT 0,
    "currentNarrative" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "game_sessions_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "turns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'action-submission',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "turns_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "turns_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "game_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "action_submissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "roomPlayerId" TEXT NOT NULL,
    "actionText" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "action_submissions_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "action_submissions_roomPlayerId_fkey" FOREIGN KEY ("roomPlayerId") REFERENCES "room_players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "check_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "roomPlayerId" TEXT NOT NULL,
    "checkType" TEXT NOT NULL,
    "skill" TEXT,
    "diceType" TEXT NOT NULL DEFAULT 'd20',
    "dc" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "check_requests_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "check_requests_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "action_submissions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "check_requests_roomPlayerId_fkey" FOREIGN KEY ("roomPlayerId") REFERENCES "room_players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "roll_submissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checkId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "roomPlayerId" TEXT NOT NULL,
    "diceResult" INTEGER NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "roll_submissions_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "check_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "roll_submissions_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "roll_submissions_roomPlayerId_fkey" FOREIGN KEY ("roomPlayerId") REFERENCES "room_players" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "resolution_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'failed',
    "finalValue" INTEGER NOT NULL,
    "statModifier" INTEGER NOT NULL DEFAULT 0,
    "skillBonus" INTEGER NOT NULL DEFAULT 0,
    "dc" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "resolution_logs_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "resolution_logs_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "check_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "game_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "logType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "turnNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_logs_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "rooms_hostId_idx" ON "rooms"("hostId");

-- CreateIndex
CREATE INDEX "room_players_roomId_idx" ON "room_players"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "room_players_userId_roomId_key" ON "room_players"("userId", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "characters_roomPlayerId_key" ON "characters"("roomPlayerId");

-- CreateIndex
CREATE INDEX "game_sessions_roomId_idx" ON "game_sessions"("roomId");

-- CreateIndex
CREATE INDEX "turns_roomId_idx" ON "turns"("roomId");

-- CreateIndex
CREATE INDEX "turns_sessionId_idx" ON "turns"("sessionId");

-- CreateIndex
CREATE INDEX "action_submissions_turnId_idx" ON "action_submissions"("turnId");

-- CreateIndex
CREATE INDEX "action_submissions_roomPlayerId_idx" ON "action_submissions"("roomPlayerId");

-- CreateIndex
CREATE INDEX "check_requests_turnId_idx" ON "check_requests"("turnId");

-- CreateIndex
CREATE INDEX "check_requests_actionId_idx" ON "check_requests"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "roll_submissions_checkId_key" ON "roll_submissions"("checkId");

-- CreateIndex
CREATE INDEX "roll_submissions_turnId_idx" ON "roll_submissions"("turnId");

-- CreateIndex
CREATE UNIQUE INDEX "resolution_logs_checkId_key" ON "resolution_logs"("checkId");

-- CreateIndex
CREATE INDEX "resolution_logs_turnId_idx" ON "resolution_logs"("turnId");

-- CreateIndex
CREATE INDEX "game_logs_roomId_idx" ON "game_logs"("roomId");
