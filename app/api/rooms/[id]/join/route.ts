import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { joinRoom } from '../../../../../lib/game-engine';

export const dynamic = 'force-dynamic';

const schema = z.object({
  userId: z.string().min(1),
  nickname: z.string().min(1).max(40),
  password: z.string().max(40).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = schema.parse(body);

    const joined = await joinRoom({
      roomId: id,
      userId: parsed.userId,
      nickname: parsed.nickname,
      password: parsed.password,
    });

    return NextResponse.json(joined, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '방 입장에 실패했습니다.' },
      { status: 400 }
    );
  }
}
