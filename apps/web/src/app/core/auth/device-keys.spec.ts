import {
  DeviceKeyStore,
  StoredDeviceKey,
  WebCryptoDeviceKeys,
  recoveryMessage,
} from './device-keys';

class MemoryStore implements DeviceKeyStore {
  stored: StoredDeviceKey | null = null;
  writes = 0;
  read = () => Promise.resolve(this.stored);
  write(key: StoredDeviceKey): Promise<void> {
    this.stored = key;
    this.writes++;
    return Promise.resolve();
  }
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

describe('recoveryMessage', () => {
  it('builds the text the API verifies: label, version, family, challenge id and nonce', () => {
    expect(recoveryMessage('f'.repeat(32), 'abc123.nonce_-x')).toBe(
      `uniover-refresh-recovery|v1|${'f'.repeat(32)}|abc123|nonce_-x`,
    );
  });

  it.each(['', 'semponto', 'a.b.c', '.nonce', 'id.'])('rejects the malformed challenge %j', (c) => {
    expect(recoveryMessage('f'.repeat(32), c)).toBeNull();
  });
});

describe('WebCryptoDeviceKeys', () => {
  it('makes a P-256 key that is not stored until the entry succeeds (commit)', async () => {
    const store = new MemoryStore();
    const keys = new WebCryptoDeviceKeys(store);

    const pending = await keys.create();

    expect(pending?.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(pending!.publicKey)).toHaveLength(91); // SPKI de uma P-256
    expect(store.writes).toBe(0);
    expect(await keys.hasKey()).toBe(false);

    await pending!.commit();
    expect(await keys.hasKey()).toBe(true);
    expect(store.writes).toBe(1);
  });

  it('keeps the private key non-exportable: scripts can ask for signatures, never copy it', async () => {
    const store = new MemoryStore();
    const keys = new WebCryptoDeviceKeys(store);
    await (await keys.create())!.commit();

    expect(store.stored!.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', store.stored!.privateKey)).rejects.toBeDefined();
  });

  it('signs with the stored key in the format the API verifies (r||s) and the signature checks out', async () => {
    const store = new MemoryStore();
    const keys = new WebCryptoDeviceKeys(store);
    const pending = (await keys.create())!;
    await pending.commit();

    const signature = (await keys.sign('mensagem'))!;

    const publicKey = await crypto.subtle.importKey(
      'spki',
      fromBase64Url(pending.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(fromBase64Url(signature)).toHaveLength(64);
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        fromBase64Url(signature),
        new TextEncoder().encode('mensagem'),
      ),
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        fromBase64Url(signature),
        new TextEncoder().encode('outra'),
      ),
    ).toBe(false);
  });

  it('makes a different key for every entry and the newest commit replaces the stored one', async () => {
    const store = new MemoryStore();
    const keys = new WebCryptoDeviceKeys(store);
    const first = (await keys.create())!;
    const second = (await keys.create())!;
    expect(second.publicKey).not.toBe(first.publicKey);

    await first.commit();
    await second.commit();

    expect(store.stored!.spki).toBe(second.publicKey);
  });

  it('reads the store on every signature (another tab may have replaced the key)', async () => {
    const store = new MemoryStore();
    const keys = new WebCryptoDeviceKeys(store);
    await (await keys.create())!.commit();
    const before = store.stored!.spki;

    await (await keys.create())!.commit();

    expect(store.stored!.spki).not.toBe(before);
    expect(await keys.sign('x')).not.toBeNull();
  });

  it('gives no signature when there is no key, and none when the store fails', async () => {
    const store = new MemoryStore();
    const keys = new WebCryptoDeviceKeys(store);
    expect(await keys.sign('x')).toBeNull();
    expect(await keys.hasKey()).toBe(false);

    store.read = () => Promise.reject(new Error('IndexedDB indisponível'));
    expect(await keys.sign('x')).toBeNull();
    expect(await keys.hasKey()).toBe(false);
  });

  it('gives no key when the browser has no WebCrypto', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      expect(await new WebCryptoDeviceKeys(new MemoryStore()).create()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
