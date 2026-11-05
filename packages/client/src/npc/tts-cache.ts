/**
 * Speech clips that outlive the tab. The proxy already caches on disk for every player;
 * this keeps each player's own lines on the machine too, so a reload costs no network at all.
 *
 * The key carries the voice signature from `/npc/health`: change the voice, and old clips
 * are ignored instead of played in the wrong voice.
 */

const DB_NAME = 'skeleton-npc';
const STORE = 'tts';
const LIMIT = 300;

interface Clip {
  key: string;
  at: number;
  data: ArrayBuffer;
}

let database: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (!database) {
    database = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('at', 'at');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return database;
}

function done<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function readClip(key: string): Promise<ArrayBuffer | null> {
  const db = await open();
  if (!db) return null;
  const record = await done<Clip | undefined>(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  return record?.data ?? null;
}

export async function writeClip(key: string, data: ArrayBuffer): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ key, at: Date.now(), data } satisfies Clip);
    const count = await done(store.count());
    if (typeof count === 'number' && count > LIMIT) {
      // Oldest first: a phrase the character stopped saying should not hold the disk forever.
      const cursor = store.index('at').openCursor();
      let remove = count - LIMIT;
      cursor.onsuccess = () => {
        const position = cursor.result;
        if (!position || remove <= 0) return;
        store.delete(position.primaryKey);
        remove -= 1;
        position.continue();
      };
    }
  } catch {
    // A full or blocked database must not break the voice.
  }
}
