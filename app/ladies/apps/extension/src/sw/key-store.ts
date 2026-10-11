// The pairing key {client_id, K_c} lives only in extension-origin IndexedDB, which content scripts cannot reach (17-e).
// K_c is stored as a non-extractable HMAC CryptoKey.

export interface ClientKey {
  client_id: string;
  key: CryptoKey;
  fingerprint: string;
}

const DB = 'salon-extension';
const STORE = 'keys';
const ID = 'client';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けません'));
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB の操作に失敗しました'));
  });
}

export const loadClientKey = async (): Promise<ClientKey | null> => (await run<ClientKey | undefined>('readonly', (s) => s.get(ID))) ?? null;
export const saveClientKey = (k: ClientKey): Promise<unknown> => run('readwrite', (s) => s.put(k, ID));
