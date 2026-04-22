import { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import {
  buildRoomSnapshot,
  endGame,
  joinRoom,
  leaveRoom,
  setPlayerReady,
  startGame,
  updateCharacter,
  updateRoomConfig,
  submitAction,
  submitRoll,
} from '../lib/game-engine.ts';
import { prisma } from '../lib/prisma.ts';
import type { ClientToServerEvents, ServerToClientEvents } from '../lib/types.ts';

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

const socketSessions = new Map<string, { roomId: string; roomPlayerId: string }>();
const PRESENCE_RECONCILE_INTERVAL_MS = parsePositiveInt(process.env.PRESENCE_RECONCILE_INTERVAL_MS, 30_000);
const EMPTY_ROOM_GRACE_MS = parsePositiveInt(process.env.EMPTY_ROOM_GRACE_MS, 180_000);

export function registerSocketServer(httpServer: HttpServer): SocketIOServer<ClientToServerEvents, ServerToClientEvents> {
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    path: '/socket.io',
    cors: {
      origin: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
      methods: ['GET', 'POST'],
    },
  });

  void reconcilePresenceAndCleanup(io);
  const intervalId = setInterval(() => {
    void reconcilePresenceAndCleanup(io);
  }, PRESENCE_RECONCILE_INTERVAL_MS);
  httpServer.on('close', () => {
    clearInterval(intervalId);
  });

  io.on('connection', (socket: GameSocket) => {
    socket.on('room:join', async (payload, ack) => {
      try {
        const joined = await joinRoom(payload);
        socket.join(payload.roomId);
        socketSessions.set(socket.id, { roomId: payload.roomId, roomPlayerId: joined.roomPlayerId });
        io.to(payload.roomId).emit('room:update', joined.snapshot);
        ack({ ok: true, data: joined });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('room:leave', async (payload, ack) => {
      try {
        const session = socketSessions.get(socket.id);
        if (!session || session.roomId !== payload.roomId) {
          ack({ ok: false, error: 'Unable to verify joined room.' });
          return;
        }

        socket.leave(payload.roomId);
        socketSessions.delete(socket.id);

        if (hasAnotherActiveSocketForRoomPlayer(session.roomPlayerId)) {
          ack({ ok: true });
          return;
        }

        const snapshot = await leaveRoom({
          roomId: payload.roomId,
          roomPlayerId: session.roomPlayerId,
        });
        io.to(payload.roomId).emit('room:update', snapshot);
        ack({ ok: true });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('room:sync', async (payload, ack) => {
      try {
        const snapshot = await buildRoomSnapshot(payload.roomId);
        ack({ ok: true, data: snapshot });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('room:config:update', async (payload, ack) => {
      try {
        const session = socketSessions.get(socket.id);
        if (!session || session.roomId !== payload.roomId) {
          ack({ ok: false, error: 'Unable to verify room config update permission.' });
          return;
        }

        const snapshot = await updateRoomConfig({
          roomId: payload.roomId,
          actorRoomPlayerId: session.roomPlayerId,
          turnMode: payload.turnMode,
          rollMode: payload.rollMode,
          llmModel: payload.llmModel,
        });
        io.to(payload.roomId).emit('room:update', snapshot);
        ack({ ok: true, data: snapshot });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('game:start', async (payload, ack) => {
      try {
        const session = socketSessions.get(socket.id);
        if (!session || session.roomId !== payload.roomId) {
          ack({ ok: false, error: 'Unable to verify game start permission.' });
          return;
        }

        const result = await startGame({
          roomId: payload.roomId,
          actorRoomPlayerId: session.roomPlayerId,
        });
        publishEvents(io, payload.roomId, result.events);
        ack({ ok: true });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('game:end', async (payload, ack) => {
      try {
        const session = socketSessions.get(socket.id);
        if (!session || session.roomId !== payload.roomId) {
          ack({ ok: false, error: 'Unable to verify game end permission.' });
          return;
        }

        const result = await endGame({
          roomId: payload.roomId,
          actorRoomPlayerId: session.roomPlayerId,
        });
        publishEvents(io, payload.roomId, result.events);
        ack({ ok: true });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('character:update', async (payload, ack) => {
      try {
        const session = socketSessions.get(socket.id);
        if (!session || session.roomId !== payload.roomId) {
          ack({ ok: false, error: 'Unable to verify character update permission.' });
          return;
        }

        const snapshot = await updateCharacter({
          roomId: payload.roomId,
          actorRoomPlayerId: session.roomPlayerId,
          name: payload.name,
          role: payload.role,
          hp: payload.hp,
          mp: payload.mp,
          stats: payload.stats,
          skills: payload.skills,
        });
        io.to(payload.roomId).emit('room:update', snapshot);
        ack({ ok: true, data: snapshot });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('player:ready', async (payload, ack) => {
      try {
        const session = socketSessions.get(socket.id);
        if (!session || session.roomId !== payload.roomId) {
          ack({ ok: false, error: 'Unable to verify ready update permission.' });
          return;
        }

        const snapshot = await setPlayerReady({
          roomId: payload.roomId,
          actorRoomPlayerId: session.roomPlayerId,
          ready: payload.ready,
        });
        io.to(payload.roomId).emit('room:update', snapshot);
        ack({ ok: true, data: snapshot });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('action:submit', async (payload, ack) => {
      try {
        const session = socketSessions.get(socket.id);
        if (!session || session.roomId !== payload.roomId) {
          ack({ ok: false, error: 'Unable to verify action submit permission.' });
          return;
        }

        const result = await submitAction({
          roomId: payload.roomId,
          roomPlayerId: session.roomPlayerId,
          actionText: payload.actionText,
        });
        publishEvents(io, payload.roomId, result.events);
        ack({ ok: true });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('roll:submit', async (payload, ack) => {
      try {
        const session = socketSessions.get(socket.id);
        if (!session || session.roomId !== payload.roomId) {
          ack({ ok: false, error: 'Unable to verify roll submit permission.' });
          return;
        }

        const result = await submitRoll({
          roomId: payload.roomId,
          roomPlayerId: session.roomPlayerId,
          checkId: payload.checkId,
          diceResult: payload.diceResult,
        });
        publishEvents(io, payload.roomId, result.events);
        ack({ ok: true });
      } catch (error) {
        ack({ ok: false, error: toMessage(error) });
      }
    });

    socket.on('disconnect', async () => {
      const session = socketSessions.get(socket.id);
      if (!session) return;

      socketSessions.delete(socket.id);
      if (hasAnotherActiveSocketForRoomPlayer(session.roomPlayerId)) return;
      try {
        const snapshot = await leaveRoom({
          roomId: session.roomId,
          roomPlayerId: session.roomPlayerId,
        });
        io.to(session.roomId).emit('room:update', snapshot);
      } catch {
        socket.emit('server:error', { message: 'Failed to update disconnect state.' });
      }
    });
  });

  return io;
}

function publishEvents(
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>,
  roomId: string,
  events: Array<{ type: string; payload: unknown }>
) {
  for (const event of events) {
    switch (event.type) {
      case 'room:update':
        io.to(roomId).emit('room:update', event.payload as Parameters<ServerToClientEvents['room:update']>[0]);
        break;
      case 'turn:scene':
        io.to(roomId).emit('turn:scene', event.payload as Parameters<ServerToClientEvents['turn:scene']>[0]);
        break;
      case 'check:requested':
        io.to(roomId).emit(
          'check:requested',
          event.payload as Parameters<ServerToClientEvents['check:requested']>[0]
        );
        break;
      case 'turn:resolve':
        io.to(roomId).emit('turn:resolve', event.payload as Parameters<ServerToClientEvents['turn:resolve']>[0]);
        break;
      case 'game:log':
        io.to(roomId).emit('game:log', event.payload as Parameters<ServerToClientEvents['game:log']>[0]);
        break;
      case 'game:end':
        io.to(roomId).emit('game:end', event.payload as Parameters<ServerToClientEvents['game:end']>[0]);
        break;
      default:
        break;
    }
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unexpected server error.';
}

function hasAnotherActiveSocketForRoomPlayer(roomPlayerId: string): boolean {
  for (const session of socketSessions.values()) {
    if (session.roomPlayerId === roomPlayerId) {
      return true;
    }
  }
  return false;
}

async function reconcilePresenceAndCleanup(io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>): Promise<void> {
  try {
    const activeRoomPlayerIds = Array.from(
      new Set(Array.from(socketSessions.values()).map((session) => session.roomPlayerId))
    );

    const staleWhere =
      activeRoomPlayerIds.length === 0
        ? { connected: true }
        : {
            connected: true,
            id: { notIn: activeRoomPlayerIds },
          };

    const stalePlayers = await prisma.roomPlayer.findMany({
      where: staleWhere,
      select: {
        id: true,
        roomId: true,
      },
    });

    if (stalePlayers.length > 0) {
      await prisma.roomPlayer.updateMany({
        where: {
          id: {
            in: stalePlayers.map((player) => player.id),
          },
        },
        data: { connected: false },
      });

      const changedRoomIds = Array.from(new Set(stalePlayers.map((player) => player.roomId)));
      for (const roomId of changedRoomIds) {
        const snapshot = await buildRoomSnapshot(roomId);
        io.to(roomId).emit('room:update', snapshot);
      }
    }

    await closeEmptyRooms(io);
  } catch (error) {
    console.error('Presence reconciliation failed:', error);
  }
}

async function closeEmptyRooms(io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>): Promise<void> {
  const now = Date.now();
  const targetRooms = await prisma.room.findMany({
    where: {
      gameStatus: {
        in: ['waiting', 'in_progress'],
      },
    },
    include: {
      players: {
        select: {
          connected: true,
          updatedAt: true,
        },
      },
    },
  });

  for (const room of targetRooms) {
    if (room.players.some((player) => player.connected)) continue;

    const latestPresenceAtMs = room.players.reduce(
      (latest, player) => Math.max(latest, player.updatedAt.getTime()),
      room.createdAt.getTime()
    );

    if (now - latestPresenceAtMs < EMPTY_ROOM_GRACE_MS) continue;

    await prisma.room.update({
      where: { id: room.id },
      data: {
        gameStatus: 'finished',
        currentTurnId: null,
      },
    });

    await prisma.gameSession.updateMany({
      where: {
        roomId: room.id,
        finishedAt: null,
      },
      data: {
        finishedAt: new Date(),
      },
    });

    const snapshot = await buildRoomSnapshot(room.id);
    io.to(room.id).emit('game:end', { roomId: room.id, reason: 'empty_timeout' });
    io.to(room.id).emit('room:update', snapshot);
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
