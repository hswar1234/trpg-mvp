import { createServer } from 'node:http';
import next from 'next';
import { registerSocketServer } from './server/socket.ts';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME ?? 'localhost';
const port = Number(process.env.PORT ?? 3000);

async function bootstrap() {
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  registerSocketServer(httpServer);

  httpServer.listen(port, () => {
    console.log(`TRPG server ready on http://${hostname}:${port}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap server', error);
  process.exit(1);
});
