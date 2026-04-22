import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '../../../../../lib/prisma';

const schema = z.object({
  roomPlayerId: z.string().min(1),
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(40),
  hp: z.number().int().min(1).max(200).default(12),
  mp: z.number().int().min(0).max(200).default(6),
  stats: z.object({
    strength: z.number().int().min(1).max(20),
    dexterity: z.number().int().min(1).max(20),
    intelligence: z.number().int().min(1).max(20),
    charisma: z.number().int().min(1).max(20),
    constitution: z.number().int().min(1).max(20),
    wisdom: z.number().int().min(1).max(20),
  }),
  skills: z.record(z.string(), z.number().int()).default({}),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.parse(body);

    const character = await prisma.character.upsert({
      where: { roomPlayerId: parsed.roomPlayerId },
      update: {
        name: parsed.name,
        class: parsed.role,
        hp: parsed.hp,
        maxHp: parsed.hp,
        mp: parsed.mp,
        maxMp: parsed.mp,
        strength: parsed.stats.strength,
        dexterity: parsed.stats.dexterity,
        intelligence: parsed.stats.intelligence,
        charisma: parsed.stats.charisma,
        constitution: parsed.stats.constitution,
        wisdom: parsed.stats.wisdom,
        skills: JSON.stringify(parsed.skills),
      },
      create: {
        roomPlayerId: parsed.roomPlayerId,
        name: parsed.name,
        class: parsed.role,
        hp: parsed.hp,
        maxHp: parsed.hp,
        mp: parsed.mp,
        maxMp: parsed.mp,
        strength: parsed.stats.strength,
        dexterity: parsed.stats.dexterity,
        intelligence: parsed.stats.intelligence,
        charisma: parsed.stats.charisma,
        constitution: parsed.stats.constitution,
        wisdom: parsed.stats.wisdom,
        skills: JSON.stringify(parsed.skills),
      },
    });

    return NextResponse.json(character);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }
    console.error('Character upsert failed:', error);
    return NextResponse.json({ error: '캐릭터 저장에 실패했습니다.' }, { status: 500 });
  }
}
