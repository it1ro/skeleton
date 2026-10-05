import { decode, encode, type ClientMessage, type ServerMessage } from '@skeleton/shared';

type Welcome = Extract<ServerMessage, { t: 'welcome' }>;

export interface Connection {
  welcome: Welcome;
  send(msg: ClientMessage): void;
  /** Messages received since the last call, in order. */
  drain(): ServerMessage[];
  readonly open: boolean;
}

/** Connects to the game server on this page's origin and waits for the welcome message. */
export function connect(name: string): Promise<Connection> {
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
