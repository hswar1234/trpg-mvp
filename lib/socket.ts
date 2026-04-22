'use client';

import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (socket) return socket;

  const baseUrl =
    process.env.NEXT_PUBLIC_API_URL ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

  socket = io(baseUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    autoConnect: false,
  });

  return socket;
}
