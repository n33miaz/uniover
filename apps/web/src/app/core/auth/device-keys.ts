import { InjectionToken } from '@angular/core';

/** Cabeçalhos da recuperação do refresh cuja resposta se perdeu (a API confere a prova da chave do aparelho). */
export const DEVICE_KEY_HEADER = 'X-UniOver-Device-Key';
export const RECOVERY_CHALLENGE_HEADER = 'X-UniOver-Recovery-Challenge';
export const RECOVERY_PROOF_HEADER = 'X-UniOver-Recovery-Proof';

/** Rótulo e versão da mensagem assinada: precisam ser idênticos aos da API (`DeviceProof.Message`). */
const MESSAGE_PREFIX = 'uniover-refresh-recovery|v1';

/**
 * A mensagem que o aparelho assina: a família, o id do desafio e o nonce. `challenge` é o `id.nonce` que a API emitiu;
 * `familyId` vem com os 32 hexadecimais da resposta do desafio.
 */
export function recoveryMessage(familyId: string, challenge: string): string | null {
  const [id, nonce, ...rest] = challenge.split('.');
  if (!id || !nonce || rest.length > 0) return null;
  return `${MESSAGE_PREFIX}|${familyId}|${id}|${nonce}`;
}

/** Chave gerada para uma sessão que ainda não nasceu: só vira a chave do aparelho depois que a entrada deu certo. */
export interface PendingDeviceKey {
  /** Chave pública (SPKI em base64url) que a API grava na família da sessão. */
  readonly publicKey: string;
  /** Guarda o par no aparelho, no lugar do anterior (uma sessão por navegador). */
  commit(): Promise<void>;
}

/**
 * Chave do aparelho. A cada entrada (senha, convite, QR) nasce um par ECDSA P-256 **não exportável**, guardado no
 * IndexedDB: nem um script da página copia a chave privada, só pede assinaturas. Sem suporte (ou com o armazenamento
 * apagado) tudo devolve `null` e a sessão segue como antes, sem recuperação (o reuso do refresh revoga).
 */
export interface DeviceKeys {
  /** Par novo para a sessão que está para nascer; `null` sem suporte. Nada é guardado antes do `commit`. */
  create(): Promise<PendingDeviceKey | null>;
  /** Há uma chave guardada? Sem ela não há como provar nada. */
  hasKey(): Promise<boolean>;
  /** Assina a mensagem com a chave guardada (lida a cada chamada, nunca de memória); `null` se não há chave ou falha. */
  sign(message: string): Promise<string | null>;
}

export interface StoredDeviceKey {
  readonly privateKey: CryptoKey;
  readonly spki: string;
}

/** Onde o par fica guardado; separado para os testes não dependerem do navegador. */
export interface DeviceKeyStore {
  read(): Promise<StoredDeviceKey | null>;
  write(key: StoredDeviceKey): Promise<void>;
}

export const DEVICE_KEYS = new InjectionToken<DeviceKeys>('DEVICE_KEYS', {
  providedIn: 'root',
  factory: () => new WebCryptoDeviceKeys(new IndexedDbKeyStore()),
});

const DB_NAME = 'uniover-device';
const STORE = 'keys';
const RECORD = 'refresh-proof';

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

export class IndexedDbKeyStore implements DeviceKeyStore {
  async read(): Promise<StoredDeviceKey | null> {
    if (typeof indexedDB === 'undefined') return null;
    const db = await openDb();
    try {
      const stored = (await request(db.transaction(STORE).objectStore(STORE).get(RECORD))) as
        | StoredDeviceKey
        | undefined;
      return stored?.privateKey && stored.spki ? stored : null;
    } finally {
      db.close();
    }
  }

  async write(key: StoredDeviceKey): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      tx.objectStore(STORE).put(key, RECORD);
      await done;
    } finally {
      db.close();
    }
  }
}

export class WebCryptoDeviceKeys implements DeviceKeys {
  constructor(private readonly store: DeviceKeyStore) {}

  async create(): Promise<PendingDeviceKey | null> {
    if (!globalThis.crypto?.subtle) return null;
    try {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
        'verify',
      ]);
      const spki = base64Url(await crypto.subtle.exportKey('spki', pair.publicKey));
      return {
        publicKey: spki,
        commit: () => this.store.write({ privateKey: pair.privateKey, spki }),
      };
    } catch {
      return null;
    }
  }

  async hasKey(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  async sign(message: string): Promise<string | null> {
    const stored = await this.read();
    if (!stored) return null;
    try {
      // O WebCrypto devolve ECDSA já em r||s (IEEE P1363), o formato que a API confere.
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        stored.privateKey,
        new TextEncoder().encode(message),
      );
      return base64Url(signature);
    } catch {
      return null;
    }
  }

  private async read(): Promise<StoredDeviceKey | null> {
    try {
      return await this.store.read();
    } catch {
      return null;
    }
  }
}
