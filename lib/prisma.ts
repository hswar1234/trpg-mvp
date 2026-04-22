import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

declare global {
  var __trpgPrisma: PrismaClient | undefined;
}

export const prisma =
  global.__trpgPrisma ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({
      url: normalizeSqliteUrl(process.env.DATABASE_URL),
    }),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__trpgPrisma = prisma;
}

function normalizeSqliteUrl(urlValue: string | undefined): string {
  const raw = urlValue || 'file:./dev.db';
  if (raw === ':memory:') return raw;
  return raw.startsWith('file:') ? raw.slice(5) : raw;
}
