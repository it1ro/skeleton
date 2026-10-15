import { WebSocketServer } from 'ws';
import { DEFAULT_SEED, SERVER_PORT, TICK_RATE, createSim, decode, encode, runTicks, type ClientMessage } from '@skeleton/shared';

/** Co-op host: the shared simulation behind a WebSocket. Single player runs the same simulation in the browser. */

const seed = Number(process.env.SEED ?? DEFAULT_SEED);
const port = Number(process.env.PORT ?? SERVER_PORT);
const sim = createSim(seed, (line) => console.log(line));

const wss = new WebSocketServer({ port, path: '/ws' });

wss.on('connection', (socket) => {
  const client = sim.connect((msg) => {
    if (socket.readyState === socket.OPEN) socket.send(encode(msg));
  });
  socket.on('message', (raw) => {
    const msg = decode<ClientMessage>(raw.toString());
    if (msg) client.receive(msg);
  });
  socket.on('close', () => client.leave());
});

runTicks(() => sim.step());
console.log(`Server: ws://localhost:${port}/ws, seed ${seed}, ${TICK_RATE} Hz`);
