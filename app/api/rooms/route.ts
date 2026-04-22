import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma';
import { ALLOWED_LLM_MODELS, DEFAULT_LLM_MODEL } from '../../../lib/llm-models';
import { toRoomCode } from '../../../lib/room-code';
import { ensureUserProfile } from '../../../lib/user-profile';

export const dynamic = 'force-dynamic';

const roomCreateSchema = z.object({
  roomName: z.string().min(1).max(80),
  scenarioTheme: z.string().min(1).max(120),
  llmModel: z
    .string()
    .min(1)
    .max(80)
    .refine((value) => ALLOWED_LLM_MODELS.includes(value), {
      message: `지원하지 않는 LLM 모델입니다. (${ALLOWED_LLM_MODELS.join(', ')})`,
    })
    .default(DEFAULT_LLM_MODEL),
  ruleset: z.string().min(1).max(80).default('d20-basic'),
  maxPlayers: z.number().int().min(2).max(8).default(4),
  isPrivate: z.boolean().default(false),
  password: z.string().max(40).optional(),
  turnMode: z.enum(['simultaneous', 'sequential']).default('simultaneous'),
  statGenerationMode: z.enum(['standard_array', 'balanced', 'heroic']).default('standard_array'),
  rollMode: z.enum(['manual_input', 'server_auto']).default('manual_input'),
  hostUserId: z.string().min(1),
  hostNickname: z.string().min(1).max(40),
});

export async function GET() {
  const rooms = await prisma.room.findMany({
    where: {
      isPrivate: false,
      gameStatus: {
        in: ['waiting', 'in_progress'],
      },
    },
    include: {
      players: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 40,
  });

  const visibleRooms = rooms
    .map((room) => ({
      id: room.id,
      roomCode: toRoomCode(room.id),
      name: room.name,
      scenarioTheme: room.scenarioTheme,
      llmModel: room.llmModel,
      ruleset: room.ruleset,
      maxPlayers: room.maxPlayers,
      playerCount: room.players.filter((player) => player.connected).length,
      gameStatus: room.gameStatus,
      turnMode: room.turnMode,
      isPrivate: room.isPrivate,
      statGenerationMode: room.statGenerationMode,
      rollMode: room.rollMode,
      createdAt: room.createdAt,
    }))
    .filter((room) => room.playerCount > 0);

  return NextResponse.json(visibleRooms);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = roomCreateSchema.parse(body);

    await ensureUserProfile({
      userId: parsed.hostUserId,
      nickname: parsed.hostNickname,
    });

    const room = await prisma.room.create({
      data: {
        name: parsed.roomName,
        scenarioTheme: parsed.scenarioTheme,
        llmModel: parsed.llmModel,
        ruleset: parsed.ruleset,
        maxPlayers: parsed.maxPlayers,
        isPrivate: parsed.isPrivate,
        password: parsed.isPrivate ? parsed.password : null,
        turnMode: parsed.turnMode,
        statGenerationMode: parsed.statGenerationMode,
        rollMode: parsed.rollMode,
        hostId: parsed.hostUserId,
        players: {
          create: {
            userId: parsed.hostUserId,
            isHost: true,
            connected: true,
          },
        },
      },
      include: {
        players: true,
      },
    });

    return NextResponse.json(
      {
        id: room.id,
        roomCode: toRoomCode(room.id),
        hostRoomPlayerId: room.players[0]?.id ?? null,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: '요청 형식이 올바르지 않습니다.',
          details: error.flatten(),
        },
        { status: 400 }
      );
    }
    console.error('Failed to create room:', error);
    return NextResponse.json({ error: '방 생성에 실패했습니다.' }, { status: 500 });
  }
}
