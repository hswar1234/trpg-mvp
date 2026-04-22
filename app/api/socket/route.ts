import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Socket.IO endpoint available at /socket.io (custom server mode)',
    socketPath: '/socket.io',
  });
}
