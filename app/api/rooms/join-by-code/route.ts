import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../lib/prisma';
import { joinRoom } from '../../../../lib/game-engine';
import { normalizeRoomCode, ROOM_CODE_LENGTH, toRoomCode } from '../../../../lib/room-code';

export const dynamic = 'force-dynamic';

const schema = z.object({
  code: z.string().min(1).max(16),
  userId: z.string().min(1),
  nickname: z.string().min(1).max(40),
  password: z.string().max(40).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.parse(body);
    const normalizedCode = normalizeRoomCode(parsed.code);
    if (normalizedCode.length !== ROOM_CODE_LENGTH) {
      return NextResponse.json({ error: `방 코드는 ${ROOM_CODE_LENGTH}자리입니다.` }, { status: 400 });
    }

    const candidates = await prisma.room.findMany({
      where: {
        gameStatus: {
          in: ['waiting', 'in_progress'],
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const targetRoom = candidates.find((room) => toRoomCode(room.id) === normalizedCode);
    if (!targetRoom) {
      return NextResponse.json({ error: '해당 방 코드를 찾을 수 없습니다.' }, { status: 404 });
    }

    const joined = await joinRoom({
      roomId: targetRoom.id,
      userId: parsed.userId,
      nickname: parsed.nickname,
      password: parsed.password,
    });

    return NextResponse.json(
      {
        roomId: targetRoom.id,
        roomCode: toRoomCode(targetRoom.id),
        roomPlayerId: joined.roomPlayerId,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '방 코드 입장에 실패했습니다.' },
      { status: 400 }
    );
  }
}
