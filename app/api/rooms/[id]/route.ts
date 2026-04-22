import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/prisma';
import { buildRoomSnapshot } from '../../../../lib/game-engine';
import { ALLOWED_LLM_MODELS } from '../../../../lib/llm-models';

export const dynamic = 'force-dynamic';

const roomUpdateSchema = z.object({
  roomName: z.string().min(1).max(80).optional(),
  scenarioTheme: z.string().min(1).max(120).optional(),
  llmModel: z
    .string()
    .min(1)
    .max(80)
    .refine((value) => ALLOWED_LLM_MODELS.includes(value), {
      message: `지원하지 않는 LLM 모델입니다. (${ALLOWED_LLM_MODELS.join(', ')})`,
    })
    .optional(),
  ruleset: z.string().min(1).max(80).optional(),
  maxPlayers: z.number().int().min(2).max(8).optional(),
  turnMode: z.enum(['simultaneous', 'sequential']).optional(),
  statGenerationMode: z.enum(['standard_array', 'balanced', 'heroic']).optional(),
  rollMode: z.enum(['manual_input', 'server_auto']).optional(),
  actorUserId: z.string().min(1),
});

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const snapshot = await buildRoomSnapshot(id);
    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('Failed to get room snapshot:', error);
    return NextResponse.json({ error: '방 정보를 불러오지 못했습니다.' }, { status: 404 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = roomUpdateSchema.parse(body);

    const room = await prisma.room.findUnique({
      where: { id },
    });
    if (!room) {
      return NextResponse.json({ error: '방이 존재하지 않습니다.' }, { status: 404 });
    }
    if (room.hostId !== parsed.actorUserId) {
      return NextResponse.json({ error: '방장만 수정할 수 있습니다.' }, { status: 403 });
    }
    if (room.gameStatus !== 'waiting') {
      return NextResponse.json({ error: '게임 시작 후에는 방 설정을 변경할 수 없습니다.' }, { status: 400 });
    }

    await prisma.room.update({
      where: { id },
      data: {
        name: parsed.roomName,
        scenarioTheme: parsed.scenarioTheme,
        llmModel: parsed.llmModel,
        ruleset: parsed.ruleset,
        maxPlayers: parsed.maxPlayers,
        turnMode: parsed.turnMode,
        statGenerationMode: parsed.statGenerationMode,
        rollMode: parsed.rollMode,
      },
    });

    const snapshot = await buildRoomSnapshot(id);
    return NextResponse.json(snapshot);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }
    console.error('Failed to update room:', error);
    return NextResponse.json({ error: '방 설정 업데이트에 실패했습니다.' }, { status: 500 });
  }
}
