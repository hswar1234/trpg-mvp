import { prisma } from './prisma.ts';

const MAX_CREATE_RETRY = 5;

export async function ensureUserProfile(input: { userId: string; nickname: string }): Promise<void> {
  const userId = input.userId.trim();
  const nickname = normalizeNickname(input.nickname);

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });

  if (existing) {
    if (existing.username === nickname) return;
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { username: nickname },
      });
    } catch (error) {
      if (!isUniqueUsernameError(error)) throw error;
      // another user already uses this nickname. keep existing username for this user.
    }
    return;
  }

  for (let attempt = 0; attempt < MAX_CREATE_RETRY; attempt += 1) {
    const candidate = attempt === 0 ? nickname : buildFallbackNickname(nickname, userId, attempt);
    try {
      await prisma.user.create({
        data: {
          id: userId,
          username: candidate,
        },
      });
      return;
    } catch (error) {
      if (!isUniqueUsernameError(error)) throw error;
    }
  }

  throw new Error('사용자 프로필 생성에 실패했습니다. 닉네임을 바꿔 다시 시도해 주세요.');
}

function normalizeNickname(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Player';
  return trimmed.slice(0, 40);
}

function buildFallbackNickname(nickname: string, userId: string, attempt: number): string {
  const compactUser = userId.replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase();
  const suffix = compactUser || `P${attempt}`;
  const core = nickname.slice(0, Math.max(1, 40 - suffix.length - 1)).trim() || 'Player';
  return `${core}-${suffix}`;
}

function isUniqueUsernameError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (!('code' in error)) return false;
  return String(error.code) === 'P2002';
}

