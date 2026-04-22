import { prisma } from './prisma.ts';
import { generateScene, planActionChecks } from './llm.ts';
import { ALLOWED_LLM_MODELS } from './llm-models.ts';
import { resolveCheck, validateDiceResult } from './rules.ts';
import { toRoomCode } from './room-code.ts';
import { ensureUserProfile } from './user-profile.ts';
import type {
  Ability,
  CheckView,
  GameLogView,
  RoomSnapshot,
  ScenePayload,
  TurnResolvePayload,
  TurnStatus,
} from './types.ts';

type EngineEvent =
  | { type: 'room:update'; payload: RoomSnapshot }
  | { type: 'turn:scene'; payload: { turnId: string; turnNumber: number; scene: ScenePayload } }
  | { type: 'check:requested'; payload: { turnId: string; checks: CheckView[] } }
  | { type: 'turn:resolve'; payload: TurnResolvePayload }
  | { type: 'game:log'; payload: GameLogView }
  | { type: 'game:end'; payload: { roomId: string; reason: string } };

export interface EngineResult {
  events: EngineEvent[];
}

export async function joinRoom(input: {
  roomId: string;
  userId: string;
  nickname: string;
  password?: string;
}): Promise<{ roomPlayerId: string; snapshot: RoomSnapshot }> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    include: { players: true },
  });

  if (!room) throw new Error('Room not found.');
  if (room.isPrivate && room.password !== input.password) throw new Error('Invalid room password.');

  const existing = await prisma.roomPlayer.findUnique({
    where: { userId_roomId: { userId: input.userId, roomId: input.roomId } },
  });

  const occupiedSlots =
    room.gameStatus === 'waiting'
      ? room.players.filter((player) => player.connected).length
      : room.players.length;
  if (!existing && occupiedSlots >= room.maxPlayers) {
    throw new Error('Room is full.');
  }

  await ensureUserProfile({
    userId: input.userId,
    nickname: input.nickname,
  });

  const roomPlayer = existing
    ? await prisma.roomPlayer.update({
        where: { id: existing.id },
        data: { connected: true },
      })
    : await prisma.roomPlayer.create({
        data: {
          roomId: input.roomId,
          userId: input.userId,
          connected: true,
          ready: false,
        },
      });

  const snapshot = await buildRoomSnapshot(input.roomId);
  return { roomPlayerId: roomPlayer.id, snapshot };
}

export async function leaveRoom(input: { roomId: string; roomPlayerId: string }): Promise<RoomSnapshot> {
  await prisma.roomPlayer.update({
    where: { id: input.roomPlayerId },
    data: { connected: false, ready: false },
  });
  return buildRoomSnapshot(input.roomId);
}

export async function setPlayerReady(input: {
  roomId: string;
  actorRoomPlayerId: string;
  ready: boolean;
}): Promise<RoomSnapshot> {
  const roomPlayer = await prisma.roomPlayer.findUnique({
    where: { id: input.actorRoomPlayerId },
    include: { room: true },
  });

  if (!roomPlayer || roomPlayer.roomId !== input.roomId) {
    throw new Error('Ready update actor is not in the room.');
  }
  if (roomPlayer.room.gameStatus !== 'waiting') {
    throw new Error('게임 준비 상태는 시작 전 대기 상태에서만 변경할 수 있습니다.');
  }

  await prisma.roomPlayer.update({
    where: { id: input.actorRoomPlayerId },
    data: { ready: input.ready },
  });

  return buildRoomSnapshot(input.roomId);
}

export async function updateRoomConfig(input: {
  roomId: string;
  actorRoomPlayerId: string;
  turnMode?: 'simultaneous' | 'sequential';
  rollMode?: 'manual_input' | 'server_auto';
  llmModel?: string;
}): Promise<RoomSnapshot> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    include: { players: true },
  });
  if (!room) throw new Error('Room not found.');

  const actor = room.players.find((player) => player.id === input.actorRoomPlayerId);
  if (!actor?.isHost) throw new Error('Only host can update room config.');
  if (room.gameStatus !== 'waiting') throw new Error('Room config can only be changed before the game starts.');

  if (!input.turnMode && !input.rollMode && !input.llmModel) {
    throw new Error('No room config fields provided.');
  }
  if (input.llmModel && !ALLOWED_LLM_MODELS.includes(input.llmModel)) {
    throw new Error(`Unsupported llm model. (${ALLOWED_LLM_MODELS.join(', ')})`);
  }

  await prisma.room.update({
    where: { id: input.roomId },
    data: {
      turnMode: input.turnMode ?? undefined,
      rollMode: input.rollMode ?? undefined,
      llmModel: input.llmModel ?? undefined,
    },
  });
  return buildRoomSnapshot(input.roomId);
}

export async function updateCharacter(input: {
  roomId: string;
  actorRoomPlayerId: string;
  name: string;
  role: string;
  hp: number;
  mp: number;
  stats: {
    strength: number;
    dexterity: number;
    intelligence: number;
    charisma: number;
    constitution: number;
    wisdom: number;
  };
  skills: Record<string, number>;
}): Promise<RoomSnapshot> {
  const name = input.name.trim();
  const role = input.role.trim();
  if (!name) throw new Error('Character name is required.');
  if (!role) throw new Error('Character role is required.');

  const roomPlayer = await prisma.roomPlayer.findUnique({
    where: { id: input.actorRoomPlayerId },
    include: { room: true },
  });

  if (!roomPlayer || roomPlayer.roomId !== input.roomId) {
    throw new Error('Character update actor is not in the room.');
  }
  if (roomPlayer.room.gameStatus !== 'waiting') {
    throw new Error('Character setup is locked after game start.');
  }

  const hp = clampInt(input.hp, 1, 200);
  const mp = clampInt(input.mp, 0, 200);
  const stats = {
    strength: clampInt(input.stats.strength, 1, 20),
    dexterity: clampInt(input.stats.dexterity, 1, 20),
    intelligence: clampInt(input.stats.intelligence, 1, 20),
    charisma: clampInt(input.stats.charisma, 1, 20),
    constitution: clampInt(input.stats.constitution, 1, 20),
    wisdom: clampInt(input.stats.wisdom, 1, 20),
  };

  await prisma.character.upsert({
    where: { roomPlayerId: input.actorRoomPlayerId },
    update: {
      name,
      class: role,
      hp,
      maxHp: hp,
      mp,
      maxMp: mp,
      ...stats,
      skills: JSON.stringify(input.skills),
    },
    create: {
      roomPlayerId: input.actorRoomPlayerId,
      name,
      class: role,
      hp,
      maxHp: hp,
      mp,
      maxMp: mp,
      ...stats,
      skills: JSON.stringify(input.skills),
    },
  });

  return buildRoomSnapshot(input.roomId);
}

export async function startGame(input: { roomId: string; actorRoomPlayerId: string }): Promise<EngineResult> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    include: {
      players: {
        include: {
          user: true,
          character: true,
        },
      },
    },
  });

  if (!room) throw new Error('Room not found.');
  if (room.gameStatus === 'in_progress') throw new Error('Game is already in progress.');

  const actor = room.players.find((player) => player.id === input.actorRoomPlayerId);
  if (!actor?.isHost) throw new Error('Only host can start the game.');

  const connectedPlayers = room.players.filter((player) => player.connected);
  if (connectedPlayers.length === 0) {
    throw new Error('연결된 플레이어가 없어 게임을 시작할 수 없습니다.');
  }
  const unreadyPlayers = connectedPlayers.filter((player) => !player.ready);
  if (unreadyPlayers.length > 0) {
    throw new Error('모든 접속 플레이어가 준비 완료해야 게임을 시작할 수 있습니다.');
  }

  const scene = await generateScene(
    {
      scenarioTheme: room.scenarioTheme,
      currentTurn: 1,
      actions: [],
      results: [],
    },
    room.llmModel
  );

  for (const player of room.players) {
    if (!player.character) {
      const defaults = getStarterStats(room.statGenerationMode);
      await prisma.character.create({
        data: {
          roomPlayerId: player.id,
          name: `${player.user.username} Character`,
          class: 'Adventurer',
          hp: 12,
          maxHp: 12,
          mp: 6,
          maxMp: 6,
          ...defaults,
          skills: JSON.stringify({
            persuasion: 1,
            stealth: 1,
            investigation: 1,
          }),
        },
      });
    }
  }

  const session = await prisma.gameSession.create({
    data: {
      roomId: input.roomId,
      sceneNumber: 1,
    },
  });

  const turn = await prisma.turn.create({
    data: {
      roomId: input.roomId,
      sessionId: session.id,
      turnNumber: 1,
      status: 'action_waiting',
    },
  });

  await prisma.gameSession.update({
    where: { id: session.id },
    data: {
      currentNarrative: scene.sceneDescription,
      currentSceneJson: JSON.stringify(scene),
    },
  });

  await prisma.room.update({
    where: { id: input.roomId },
    data: {
      gameStatus: 'in_progress',
      currentTurnId: turn.id,
    },
  });

  const log = await prisma.gameLog.create({
    data: {
      roomId: input.roomId,
      turnNumber: 1,
      logType: 'scene',
      content: JSON.stringify(scene),
    },
  });

  const snapshot = await buildRoomSnapshot(input.roomId);
  return {
    events: [
      {
        type: 'turn:scene',
        payload: {
          turnId: turn.id,
          turnNumber: turn.turnNumber,
          scene,
        },
      },
      { type: 'game:log', payload: mapLog(log) },
      { type: 'room:update', payload: snapshot },
    ],
  };
}

export async function endGame(input: { roomId: string; actorRoomPlayerId: string }): Promise<EngineResult> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    include: { players: true },
  });
  if (!room) throw new Error('Room not found.');

  const actor = room.players.find((player) => player.id === input.actorRoomPlayerId);
  if (!actor?.isHost) throw new Error('Only host can end the game.');

  await prisma.room.update({
    where: { id: input.roomId },
    data: {
      gameStatus: 'finished',
      currentTurnId: null,
    },
  });

  const activeSession = await prisma.gameSession.findFirst({
    where: { roomId: input.roomId, finishedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (activeSession) {
    await prisma.gameSession.update({
      where: { id: activeSession.id },
      data: { finishedAt: new Date() },
    });
  }

  const snapshot = await buildRoomSnapshot(input.roomId);
  return {
    events: [
      {
        type: 'game:end',
        payload: { roomId: input.roomId, reason: 'host_ended' },
      },
      {
        type: 'room:update',
        payload: snapshot,
      },
    ],
  };
}

export async function submitAction(input: {
  roomId: string;
  roomPlayerId: string;
  actionText: string;
}): Promise<EngineResult> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    include: {
      players: true,
    },
  });
  if (!room || !room.currentTurnId) throw new Error('No active turn.');

  const turn = await prisma.turn.findUnique({
    where: { id: room.currentTurnId },
    include: {
      actions: true,
    },
  });
  if (!turn) throw new Error('Turn not found.');
  if (turn.status !== 'action_waiting') throw new Error('Not in action phase.');

  ensureSequentialTurn(room.turnMode, room.players, turn.actions.map((action) => action.roomPlayerId), input.roomPlayerId);

  const existing = turn.actions.find((action) => action.roomPlayerId === input.roomPlayerId);
  if (existing) {
    await prisma.actionSubmission.update({
      where: { id: existing.id },
      data: { actionText: input.actionText },
    });
  } else {
    await prisma.actionSubmission.create({
      data: {
        turnId: turn.id,
        roomPlayerId: input.roomPlayerId,
        actionText: input.actionText,
      },
    });
  }

  const actor = await prisma.roomPlayer.findUnique({
    where: { id: input.roomPlayerId },
    include: { user: true },
  });
  let actionLog: GameLogView | null = null;
  if (actor) {
    const createdLog = await prisma.gameLog.create({
      data: {
        roomId: input.roomId,
        turnNumber: turn.turnNumber,
        logType: 'action',
        content: `${actor.user.username}: ${input.actionText}`,
      },
    });
    actionLog = mapLog(createdLog);
  }

  const connectedPlayers = room.players.filter((player) => player.connected);
  const actionCount = await prisma.actionSubmission.count({
    where: { turnId: turn.id, roomPlayerId: { in: connectedPlayers.map((player) => player.id) } },
  });

  if (actionCount < connectedPlayers.length) {
    const snapshot = await buildRoomSnapshot(input.roomId);
    return {
      events: [
        ...(actionLog ? [{ type: 'game:log', payload: actionLog } as const] : []),
        { type: 'room:update', payload: snapshot },
      ],
    };
  }

  const result = await planChecksForTurn({
    roomId: input.roomId,
    turnId: turn.id,
    sessionId: turn.sessionId,
    turnNumber: turn.turnNumber,
  });
  return {
    events: [
      ...(actionLog ? [{ type: 'game:log', payload: actionLog } as const] : []),
      ...result.events,
    ],
  };
}

export async function submitRoll(input: {
  roomId: string;
  roomPlayerId: string;
  checkId: string;
  diceResult: number;
}): Promise<EngineResult> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
  });
  if (!room || !room.currentTurnId) throw new Error('No active turn.');

  const turn = await prisma.turn.findUnique({
    where: { id: room.currentTurnId },
  });
  if (!turn || turn.status !== 'roll_waiting') throw new Error('Not in roll phase.');

  const check = await prisma.checkRequest.findUnique({
    where: { id: input.checkId },
    include: {
      roomPlayer: { include: { character: true } },
      action: true,
      roll: true,
      resolution: true,
    },
  });

  if (!check || check.turnId !== turn.id) throw new Error('Invalid check.');
  if (check.roomPlayerId !== input.roomPlayerId) throw new Error('Cannot submit roll for another player.');
  if (!check.roomPlayer.character) throw new Error('Character data not found.');
  if (room.rollMode === 'manual_input' && !validateDiceResult(check.diceType, input.diceResult)) {
    throw new Error('Dice result out of range.');
  }

  const finalRoll = room.rollMode === 'server_auto' ? randomDice(check.diceType) : input.diceResult;

  if (check.roll) {
    await prisma.rollSubmission.update({
      where: { checkId: check.id },
      data: { diceResult: finalRoll },
    });
  } else {
    await prisma.rollSubmission.create({
      data: {
        checkId: check.id,
        turnId: turn.id,
        roomPlayerId: input.roomPlayerId,
        diceResult: finalRoll,
      },
    });
  }

  const character = check.roomPlayer.character;
  const resolved = resolveCheck({
    stat: check.checkType as Ability,
    skill: check.skill,
    dc: check.dc,
    diceResult: finalRoll,
    stats: {
      strength: character.strength,
      dexterity: character.dexterity,
      intelligence: character.intelligence,
      charisma: character.charisma,
      constitution: character.constitution,
      wisdom: character.wisdom,
    },
    skills: parseSkills(character.skills),
  });

  if (check.resolution) {
    await prisma.resolutionLog.update({
      where: { checkId: check.id },
      data: {
        result: resolved.result,
        finalValue: resolved.finalValue,
        statModifier: resolved.statModifier,
        skillBonus: resolved.skillBonus,
        dc: resolved.dc,
      },
    });
  } else {
    await prisma.resolutionLog.create({
      data: {
        turnId: turn.id,
        checkId: check.id,
        result: resolved.result,
        finalValue: resolved.finalValue,
        statModifier: resolved.statModifier,
        skillBonus: resolved.skillBonus,
        dc: resolved.dc,
      },
    });
  }

  const createdResultLog = await prisma.gameLog.create({
    data: {
      roomId: input.roomId,
      turnNumber: turn.turnNumber,
      logType: 'result',
      content: JSON.stringify({
        actionText: check.action.actionText,
        d20: finalRoll,
        total: resolved.finalValue,
        result: resolved.result,
        preRollNarrative: parseCheckNarrative(check.reason).preRollNarrative,
        consequence: consequenceByResult(parseCheckNarrative(check.reason), resolved.result),
      }),
    },
  });
  const resultLog = mapLog(createdResultLog);

  const unresolved = await prisma.checkRequest.findMany({
    where: { turnId: turn.id },
    include: { resolution: true },
  });

  if (unresolved.some((item) => !item.resolution)) {
    const snapshot = await buildRoomSnapshot(input.roomId);
    return {
      events: [
        { type: 'game:log', payload: resultLog },
        { type: 'room:update', payload: snapshot },
      ],
    };
  }

  const finalized = await finalizeTurn({
    roomId: input.roomId,
    turnId: turn.id,
    sessionId: turn.sessionId,
    turnNumber: turn.turnNumber,
  });
  return {
    events: [{ type: 'game:log', payload: resultLog }, ...finalized.events],
  };
}

export async function buildRoomSnapshot(roomId: string): Promise<RoomSnapshot> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      players: {
        include: {
          user: true,
          character: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!room) throw new Error('Room not found.');

  const session = await prisma.gameSession.findFirst({
    where: { roomId, finishedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  const turn = room.currentTurnId
    ? await prisma.turn.findUnique({
        where: { id: room.currentTurnId },
        include: {
          actions: true,
          checks: {
            include: {
              roll: true,
              resolution: true,
            },
          },
          resolutions: {
            include: {
              checkRequest: {
                include: { action: true },
              },
            },
          },
        },
      })
    : null;

  const logs = await prisma.gameLog.findMany({
    where: { roomId },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });

  const actions = turn?.actions ?? [];
  const checks = turn?.checks ?? [];
  const resolutions = turn?.resolutions ?? [];

  const connectedPlayers = room.players.filter((player) => player.connected);
  const pendingActionPlayerIds =
    turn?.status === 'action_waiting'
      ? connectedPlayers
          .filter((player) => !actions.some((action) => action.roomPlayerId === player.id))
          .map((player) => player.id)
      : [];

  const pendingRollPlayerIds =
    turn?.status === 'roll_waiting'
      ? connectedPlayers
          .filter((player) =>
            checks.some((check) => check.roomPlayerId === player.id && (!check.roll || !check.resolution))
          )
          .map((player) => player.id)
      : [];

  return {
    room: {
      id: room.id,
      roomCode: toRoomCode(room.id),
      name: room.name,
      scenarioTheme: room.scenarioTheme,
      llmModel: room.llmModel,
      ruleset: room.ruleset,
      maxPlayers: room.maxPlayers,
      isPrivate: room.isPrivate,
      turnMode: room.turnMode as RoomSnapshot['room']['turnMode'],
      rollMode: room.rollMode as RoomSnapshot['room']['rollMode'],
      statGenerationMode: room.statGenerationMode,
      gameStatus: room.gameStatus as RoomSnapshot['room']['gameStatus'],
      hostUserId: room.hostId,
      currentTurnId: room.currentTurnId,
    },
    session: session
      ? {
          id: session.id,
          sceneNumber: session.sceneNumber,
          narrative: session.currentNarrative,
        }
      : null,
    currentTurn: turn
      ? {
          id: turn.id,
          turnNumber: turn.turnNumber,
          status: turn.status as TurnStatus,
        }
      : null,
    scene: resolveScene(session?.currentSceneJson, session?.currentNarrative),
    players: room.players.map((player) => {
      const playerActions = actions.filter((action) => action.roomPlayerId === player.id);
      const playerChecks = checks.filter((check) => check.roomPlayerId === player.id);
      const unresolvedCount = playerChecks.filter((check) => !check.resolution).length;
      return {
        roomPlayerId: player.id,
        userId: player.userId,
        nickname: player.user.username,
        isHost: player.isHost,
        connected: player.connected,
        isReady: player.ready,
        hasSubmittedAction: playerActions.length > 0,
        hasSubmittedRoll: playerChecks.length > 0 ? unresolvedCount === 0 : true,
        pendingChecks: unresolvedCount,
        character: player.character
          ? {
              id: player.character.id,
              name: player.character.name,
              role: player.character.class,
              hp: player.character.hp,
              maxHp: player.character.maxHp,
              mp: player.character.mp,
              maxMp: player.character.maxMp,
              stats: {
                strength: player.character.strength,
                dexterity: player.character.dexterity,
                intelligence: player.character.intelligence,
                charisma: player.character.charisma,
                constitution: player.character.constitution,
                wisdom: player.character.wisdom,
              },
              skills: parseSkills(player.character.skills),
            }
          : null,
      };
    }),
    actions: actions.map((action) => ({
      id: action.id,
      roomPlayerId: action.roomPlayerId,
      actionText: action.actionText,
      submittedAt: action.submittedAt.toISOString(),
    })),
    checks: checks.map((check) => ({
      id: check.id,
      roomPlayerId: check.roomPlayerId,
      actionId: check.actionId,
      checkType: check.checkType as Ability,
      skill: check.skill,
      diceType: check.diceType,
      dc: check.dc,
      reason: check.reason,
      rollResult: check.roll?.diceResult ?? null,
      resolved: Boolean(check.resolution),
    })),
    resolutions: resolutions.map((resolution) => ({
      id: resolution.id,
      checkId: resolution.checkId,
      roomPlayerId: resolution.checkRequest.roomPlayerId,
      result: resolution.result as RoomSnapshot['resolutions'][number]['result'],
      finalValue: resolution.finalValue,
      statModifier: resolution.statModifier,
      skillBonus: resolution.skillBonus,
      dc: resolution.dc,
      actionText: resolution.checkRequest.action.actionText,
    })),
    pendingActionPlayerIds,
    pendingRollPlayerIds,
    logs: logs.reverse().map(mapLog),
  };
}

async function planChecksForTurn(input: {
  roomId: string;
  turnId: string;
  sessionId: string;
  turnNumber: number;
}): Promise<EngineResult> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    include: {
      players: {
        include: {
          user: true,
          character: true,
        },
      },
    },
  });
  if (!room) throw new Error('Room not found.');

  await prisma.turn.update({
    where: { id: input.turnId },
    data: { status: 'resolving' },
  });

  const session = await prisma.gameSession.findUnique({
    where: { id: input.sessionId },
  });

  const actions = await prisma.actionSubmission.findMany({
    where: { turnId: input.turnId },
    include: {
      roomPlayer: {
        include: {
          user: true,
          character: true,
        },
      },
    },
    orderBy: { submittedAt: 'asc' },
  });

  await prisma.rollSubmission.deleteMany({ where: { turnId: input.turnId } });
  await prisma.resolutionLog.deleteMany({ where: { turnId: input.turnId } });
  await prisma.checkRequest.deleteMany({ where: { turnId: input.turnId } });

  let planning: Awaited<ReturnType<typeof planActionChecks>>;
  try {
    planning = await planActionChecks(
      {
        scenarioTheme: room.scenarioTheme,
        currentScene: session?.currentNarrative ?? '',
        ruleset: room.ruleset,
        actions: actions.map((action) => ({
          playerId: action.roomPlayerId,
          playerName: action.roomPlayer.user.username,
          actionText: action.actionText,
          characterStats: {
            strength: action.roomPlayer.character?.strength ?? 10,
            dexterity: action.roomPlayer.character?.dexterity ?? 10,
            intelligence: action.roomPlayer.character?.intelligence ?? 10,
            charisma: action.roomPlayer.character?.charisma ?? 10,
            constitution: action.roomPlayer.character?.constitution ?? 10,
            wisdom: action.roomPlayer.character?.wisdom ?? 10,
          },
          skills: parseSkills(action.roomPlayer.character?.skills ?? '{}'),
        })),
      },
      room.llmModel
    );
  } catch (error) {
    await prisma.turn.update({
      where: { id: input.turnId },
      data: { status: 'action_waiting' },
    });
    throw error;
  }

  let createdChecks = 0;
  const checkLogs: GameLogView[] = [];
  for (const action of actions) {
    const proposal =
      planning.resolutions.find((resolution) => resolution.playerId === action.roomPlayerId) ??
      planning.resolutions.find((resolution) => resolution.actionText === action.actionText);

    if (!proposal || !proposal.checkRequired) {
      const syntheticCheckId = await createSyntheticCheck(input.turnId, action.id, action.roomPlayerId);
      await prisma.resolutionLog.create({
        data: {
          turnId: input.turnId,
          checkId: syntheticCheckId,
          result: 'success',
          finalValue: 0,
          statModifier: 0,
          skillBonus: 0,
          dc: 0,
        },
      });
      const noCheckLog = await prisma.gameLog.create({
        data: {
          roomId: input.roomId,
          turnNumber: input.turnNumber,
          logType: 'check',
          content: `${action.roomPlayer.user.username}: no check required`,
        },
      });
      checkLogs.push(mapLog(noCheckLog));
      continue;
    }

    const createdCheck = await prisma.checkRequest.create({
      data: {
        turnId: input.turnId,
        actionId: action.id,
        roomPlayerId: action.roomPlayerId,
        checkType: proposal.checkType,
        skill: proposal.skill,
        diceType: proposal.dice,
        dc: proposal.dc,
        reason: JSON.stringify({
          reason: proposal.reason,
          preRollNarrative: proposal.preRollNarrative,
          successOutcome: proposal.successOutcome,
          partialOutcome: proposal.partialOutcome,
          failureOutcome: proposal.failureOutcome,
        }),
      },
    });
    createdChecks += 1;

    const checkLog = await prisma.gameLog.create({
      data: {
        roomId: input.roomId,
        turnNumber: input.turnNumber,
        logType: 'check',
        content: JSON.stringify({
          playerName: action.roomPlayer.user.username,
          actionText: action.actionText,
          checkType: createdCheck.checkType,
          skill: createdCheck.skill,
          dc: createdCheck.dc,
          preRollNarrative: proposal.preRollNarrative,
          successOutcome: proposal.successOutcome,
          partialOutcome: proposal.partialOutcome,
          failureOutcome: proposal.failureOutcome,
        }),
      },
    });
    checkLogs.push(mapLog(checkLog));
  }

  if (createdChecks === 0) {
    const finalized = await finalizeTurn(input);
    return {
      events: [...checkLogs.map((log) => ({ type: 'game:log', payload: log } as const)), ...finalized.events],
    };
  }

  await prisma.turn.update({
    where: { id: input.turnId },
    data: { status: 'roll_waiting' },
  });

  const snapshot = await buildRoomSnapshot(input.roomId);
  return {
    events: [
      ...checkLogs.map((log) => ({ type: 'game:log', payload: log } as const)),
      {
        type: 'check:requested',
        payload: {
          turnId: input.turnId,
          checks: snapshot.checks,
        },
      },
      {
        type: 'room:update',
        payload: snapshot,
      },
    ],
  };
}

async function finalizeTurn(input: {
  roomId: string;
  turnId: string;
  sessionId: string;
  turnNumber: number;
}): Promise<EngineResult> {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
  });
  if (!room) throw new Error('Room not found.');

  const session = await prisma.gameSession.findUnique({
    where: { id: input.sessionId },
  });
  if (!session) throw new Error('Game session not found.');

  const actions = await prisma.actionSubmission.findMany({
    where: { turnId: input.turnId },
    include: {
      roomPlayer: { include: { user: true } },
    },
    orderBy: { submittedAt: 'asc' },
  });

  const resolutionRows = await prisma.resolutionLog.findMany({
    where: { turnId: input.turnId },
    include: {
      checkRequest: {
        include: {
          action: true,
          roomPlayer: { include: { user: true } },
        },
      },
    },
  });

  const resolvedViews = resolutionRows.map((resolution) => ({
    id: resolution.id,
    checkId: resolution.checkId,
    roomPlayerId: resolution.checkRequest.roomPlayerId,
    result: resolution.result as TurnResolvePayload['resolutions'][number]['result'],
    finalValue: resolution.finalValue,
    statModifier: resolution.statModifier,
    skillBonus: resolution.skillBonus,
    dc: resolution.dc,
    actionText: resolution.checkRequest.action.actionText,
  }));

  const scene = await generateScene(
    {
      scenarioTheme: room.scenarioTheme,
      currentTurn: input.turnNumber + 1,
      lastSceneDescription: session.currentNarrative,
      actions: actions.map((action) => ({
        playerName: action.roomPlayer.user.username,
        actionText: action.actionText,
      })),
      results: resolutionRows.map((resolution) => ({
        playerName: resolution.checkRequest.roomPlayer.user.username,
        actionText: resolution.checkRequest.action.actionText,
        result: resolution.result as 'failed' | 'partial' | 'success',
      })),
    },
    room.llmModel
  );

  await prisma.turn.update({
    where: { id: input.turnId },
    data: { status: 'next_scene' },
  });

  const nextTurn = await prisma.turn.create({
    data: {
      roomId: input.roomId,
      sessionId: input.sessionId,
      turnNumber: input.turnNumber + 1,
      status: 'action_waiting',
    },
  });

  await prisma.gameSession.update({
    where: { id: input.sessionId },
    data: {
      sceneNumber: input.turnNumber + 1,
      currentNarrative: scene.sceneDescription,
      currentSceneJson: JSON.stringify(scene),
    },
  });

  await prisma.room.update({
    where: { id: input.roomId },
    data: { currentTurnId: nextTurn.id },
  });

  const sceneLog = await prisma.gameLog.create({
    data: {
      roomId: input.roomId,
      turnNumber: input.turnNumber + 1,
      logType: 'scene',
      content: JSON.stringify(scene),
    },
  });

  const snapshot = await buildRoomSnapshot(input.roomId);

  return {
    events: [
      {
        type: 'turn:resolve',
        payload: {
          turnId: input.turnId,
          turnNumber: input.turnNumber,
          resolutions: resolvedViews,
        },
      },
      {
        type: 'turn:scene',
        payload: {
          turnId: nextTurn.id,
          turnNumber: nextTurn.turnNumber,
          scene,
        },
      },
      {
        type: 'game:log',
        payload: mapLog(sceneLog),
      },
      {
        type: 'room:update',
        payload: snapshot,
      },
    ],
  };
}

async function createSyntheticCheck(turnId: string, actionId: string, roomPlayerId: string): Promise<string> {
  const created = await prisma.checkRequest.create({
    data: {
      turnId,
      actionId,
      roomPlayerId,
      checkType: 'wisdom',
      skill: null,
      diceType: 'd20',
      dc: 0,
      reason: 'No check required.',
    },
  });
  return created.id;
}

function getStarterStats(mode: string) {
  if (mode === 'heroic') {
    return {
      strength: 16,
      dexterity: 14,
      intelligence: 12,
      charisma: 14,
      constitution: 13,
      wisdom: 11,
    };
  }
  if (mode === 'balanced') {
    return {
      strength: 12,
      dexterity: 12,
      intelligence: 12,
      charisma: 12,
      constitution: 12,
      wisdom: 12,
    };
  }
  return {
    strength: 15,
    dexterity: 14,
    intelligence: 13,
    charisma: 12,
    constitution: 10,
    wisdom: 8,
  };
}

function ensureSequentialTurn(
  mode: string,
  players: Array<{ id: string; connected: boolean; createdAt: Date }>,
  submittedPlayerIds: string[],
  currentPlayerId: string
) {
  if (mode !== 'sequential') return;
  const ordered = players
    .filter((player) => player.connected)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const next = ordered.find((player) => !submittedPlayerIds.includes(player.id));
  if (!next) return;
  if (next.id !== currentPlayerId) {
    throw new Error('Sequential mode: wait for your turn.');
  }
}

function resolveScene(sceneJson: string | null | undefined, narrative: string | null | undefined): ScenePayload | null {
  if (sceneJson) {
    try {
      const parsed = JSON.parse(sceneJson) as ScenePayload;
      if (parsed.summary && parsed.sceneDescription) return parsed;
    } catch {
      // no-op
    }
  }
  if (!narrative) return null;
  return {
    summary: 'Current Scene',
    sceneDescription: narrative,
    choicesHint: ['Look around', 'Take an action', 'Coordinate with party'],
    importantEntities: [],
  };
}

function parseSkills(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function parseCheckNarrative(rawReason: string): {
  reason: string;
  preRollNarrative: string;
  successOutcome: string;
  partialOutcome: string;
  failureOutcome: string;
} {
  const fallback = {
    reason: rawReason,
    preRollNarrative: rawReason,
    successOutcome: '?됰룞???깃났?곸쑝濡?留덈Т由щ맗?덈떎.',
    partialOutcome: '?쇰? ?깃낵瑜??살?留??꾪뿕???⑥뒿?덈떎.',
    failureOutcome: '?쒕졆???깃낵瑜??살? 紐삵빀?덈떎.',
  };

  try {
    const parsed = JSON.parse(rawReason) as Partial<typeof fallback>;
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      reason: parsed.reason?.trim() || fallback.reason,
      preRollNarrative: parsed.preRollNarrative?.trim() || parsed.reason?.trim() || fallback.preRollNarrative,
      successOutcome: parsed.successOutcome?.trim() || fallback.successOutcome,
      partialOutcome: parsed.partialOutcome?.trim() || fallback.partialOutcome,
      failureOutcome: parsed.failureOutcome?.trim() || fallback.failureOutcome,
    };
  } catch {
    return fallback;
  }
}

function consequenceByResult(
  narrative: {
    successOutcome: string;
    partialOutcome: string;
    failureOutcome: string;
  },
  result: 'failed' | 'partial' | 'success'
): string {
  if (result === 'success') return narrative.successOutcome;
  if (result === 'partial') return narrative.partialOutcome;
  return narrative.failureOutcome;
}

function mapLog(log: {
  id: string;
  logType: string;
  turnNumber: number;
  content: string;
  createdAt: Date;
}): GameLogView {
  return {
    id: log.id,
    logType: log.logType as GameLogView['logType'],
    turnNumber: log.turnNumber,
    content: log.content,
    createdAt: log.createdAt.toISOString(),
  };
}

function randomDice(diceType: string): number {
  if (diceType === 'd20') return Math.floor(Math.random() * 20) + 1;
  return 1;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

