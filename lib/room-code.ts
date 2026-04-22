export const ROOM_CODE_LENGTH = 6;

export function toRoomCode(roomId: string): string {
  const normalized = roomId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!normalized) return '';
  return normalized.slice(-ROOM_CODE_LENGTH);
}

export function normalizeRoomCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
