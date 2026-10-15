import { createSim, decode, encode, runTicks, type ClientMessage, type ServerMessage } from '@skeleton/shared';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

export interface Connection {
  welcome: Welcome;
  send(msg: ClientMessage): void;
  /** Messages received since the last call, in order. */
  drain(): ServerMessage[];
  readonly open: boolean;
}

/**
 * Single player: the simulation runs on this page and the game talks to it directly, with no server.
 * Messages still go through encode/decode, so the game sees exactly what a server would send.
 */
export function connectLocal(name: string, seed: number): Connection {
  const sim = createSim(seed);
  const inbox: ServerMessage[] = [];
  const client = sim.connect((msg) => {
    const copy = decode<ServerMessage>(encode(msg));
    if (copy) inbox.push(copy);
  });
  client.receive({ t: 'hello', name });
  const welcome = inbox.shift();
  if (welcome?.t !== 'welcome') throw new Error('Мир не запустился');
  runTicks(() => sim.step());

  return {
    welcome,
    send: (m) => {
      const copy = decode<ClientMessage>(encode(m));
      if (copy) client.receive(copy);
    },
    drain: () => inbox.splice(0),
    open: true,
  };
}

/** Co-op: connects to the game server on this page's origin and waits for the welcome message. */
export function connectServer(name: string): Promise<Connection> {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const socket = new WebSocket(url);
  const inbox: ServerMessage[] = [];

  return new Promise((resolve, reject) => {
    let welcomed = false;
    socket.onopen = () => socket.send(encode({ t: 'hello', name }));
    socket.onerror = () => {
      if (!welcomed) reject(new Error('Сервер недоступен'));
    };
    socket.onclose = () => {
      if (!welcomed) reject(new Error('Соединение закрыто'));
    };
    socket.onmessage = (e) => {
      const msg = decode<ServerMessage>(String(e.data));
      if (!msg) return;
      if (msg.t === 'welcome' && !welcomed) {
        welcomed = true;
        resolve({
          welcome: msg,
          send: (m) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(encode(m));
          },
          drain: () => inbox.splice(0),
          get open() {
            return socket.readyState === WebSocket.OPEN;
          },
        });
        return;
      }
      inbox.push(msg);
    };
  });
}
