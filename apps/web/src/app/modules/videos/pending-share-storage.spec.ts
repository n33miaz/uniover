import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingShare,
  INTERRUPTED_SHARE_STORAGE_KEY,
  interruptedShareId,
  markInterruptedShare,
  peekPendingShare,
  PENDING_SHARE_STORAGE_KEY,
  stashPendingShare,
} from './pending-share-storage';
import { MAX_SHARE_PARAM_LENGTH } from './share-input-limits';

describe('pending-share-storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    clearPendingShare();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    clearPendingShare();
    vi.restoreAllMocks();
  });

  it('stashes and peeks pending share without consuming it', () => {
    stashPendingShare({
      url: 'https://www.youtube.com/watch?v=123',
      text: 'Confira este video',
      title: 'YouTube',
    });

    const peeked1 = peekPendingShare();
    expect(peeked1).not.toBeNull();
    expect(peeked1?.url).toBe('https://www.youtube.com/watch?v=123');
    expect(peeked1?.text).toBe('Confira este video');
    expect(peeked1?.title).toBe('YouTube');
    expect(peeked1?.timestamp).toBeTypeOf('number');

    const peeked2 = peekPendingShare();
    expect(peeked2?.url).toBe('https://www.youtube.com/watch?v=123');
  });

  it('keeps the pending share in the tab that started sign-in', () => {
    stashPendingShare({
      url: 'https://instagram.com/reel/123/',
      text: 'Reel',
    });

    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
  });

  it('rejects a credential-bearing URL before writing to any temporary store', () => {
    stashPendingShare({ url: 'https://user:password@youtu.be/abc' });
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(peekPendingShare()).toBeNull();
  });

  it.each([
    { url: 'javascript:alert(1)' },
    { text: 'sem link nenhum' },
    { url: 'https://youtu.be/abc', title: 'Fonte https://user@example.org/privado' },
  ])('stores nothing and returns no id for an unacceptable share', (payload) => {
    expect(stashPendingShare(payload)).toBeNull();
    expect(sessionStorage.length + localStorage.length).toBe(0);
  });

  it('isolates the pending share by the id returned when stashing', () => {
    const id = stashPendingShare({ url: 'https://youtu.be/abc' });
    expect(id).toBeTypeOf('string');
    expect(peekPendingShare(id!)?.url).toBe('https://youtu.be/abc');
    expect(peekPendingShare('another-intent')).toBeNull();

    clearPendingShare('another-intent');
    expect(peekPendingShare(id!)).not.toBeNull();
  });

  it('finds the requested share in localStorage when another tab owns sessionStorage', () => {
    const id = stashPendingShare({ url: 'https://youtu.be/session' })!;
    const local = { id: 'local', timestamp: Date.now(), url: 'https://youtu.be/local' };
    localStorage.setItem(PENDING_SHARE_STORAGE_KEY, JSON.stringify(local));

    expect(peekPendingShare('local')?.url).toBe('https://youtu.be/local');
    expect(peekPendingShare(id)?.url).toBe('https://youtu.be/session');
  });

  it.each([
    ['unreadable JSON', '{not json'],
    ['without id', JSON.stringify({ timestamp: 1, url: 'https://youtu.be/abc' })],
    ['without timestamp', JSON.stringify({ id: 'old', url: 'https://youtu.be/abc' })],
    [
      'with credentials',
      JSON.stringify({ id: 'old', timestamp: 1, url: 'https://u:p@youtu.be/abc' }),
    ],
    [
      'with an unsafe scheme',
      JSON.stringify({ id: 'old', timestamp: 1, url: 'javascript:alert(1)' }),
    ],
    [
      'with non-text fields',
      JSON.stringify({ id: 'old', timestamp: 1, url: ['https://youtu.be/abc'] }),
    ],
  ])('drops a legacy stored record %s on read', (_, raw) => {
    sessionStorage.setItem(PENDING_SHARE_STORAGE_KEY, raw);
    localStorage.setItem(PENDING_SHARE_STORAGE_KEY, raw);

    expect(peekPendingShare('old')).toBeNull();
    expect(peekPendingShare()).toBeNull();
    expect(sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_SHARE_STORAGE_KEY)).toBeNull();
  });

  it('clamps oversized fields of a legacy stored record', () => {
    const huge = 'https://youtu.be/abc ' + 'x'.repeat(MAX_SHARE_PARAM_LENGTH * 2);
    sessionStorage.setItem(
      PENDING_SHARE_STORAGE_KEY,
      JSON.stringify({ id: 'old', timestamp: Date.now(), text: huge }),
    );
    expect(peekPendingShare('old')?.text).toHaveLength(MAX_SHARE_PARAM_LENGTH);
  });

  it('expires a pending share from memory and sessionStorage only after an hour', () => {
    const clock = vi.spyOn(Date, 'now');
    const timestamp = Date.now();
    const id = stashPendingShare({ url: 'https://youtu.be/abc', timestamp })!;

    clock.mockReturnValue(timestamp + 60 * 60 * 1000);
    expect(peekPendingShare(id)?.id).toBe(id);

    clock.mockReturnValue(timestamp + 60 * 60 * 1000 + 1);
    expect(peekPendingShare(id)).toBeNull();
    expect(sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY)).toBeNull();
  });

  it('offers an interrupted share only to the account that was interrupted', () => {
    const id = stashPendingShare({ url: 'https://youtu.be/abc' })!;
    markInterruptedShare(id, 'account-a');

    expect(interruptedShareId('account-a')).toBe(id);
    expect(interruptedShareId('account-b')).toBeNull();
    expect(localStorage.length).toBe(0);

    clearPendingShare('another-intent');
    expect(interruptedShareId('account-a')).toBe(id);
    clearPendingShare(id);
    expect(interruptedShareId('account-a')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('does not mark an intent without a pending record', () => {
    markInterruptedShare('unknown-intent', 'account-a');

    expect(interruptedShareId('account-a')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('reads the interrupted share left in sessionStorage by an earlier load of the tab', () => {
    sessionStorage.setItem(
      INTERRUPTED_SHARE_STORAGE_KEY,
      JSON.stringify({ id: 'before-reload', accountId: null }),
    );

    expect(interruptedShareId('account-a')).toBe('before-reload');
  });

  it.each([undefined, 42, {}, false])(
    'ignores an interrupted share with accountId %j',
    (accountId) => {
      const id = 'before-reload';
      const raw = JSON.stringify({ id, accountId });
      sessionStorage.setItem(INTERRUPTED_SHARE_STORAGE_KEY, raw);

      expect(interruptedShareId('account-a')).toBeNull();
      clearPendingShare(id);
      expect(sessionStorage.getItem(INTERRUPTED_SHARE_STORAGE_KEY)).toBe(raw);
    },
  );

  it('clears pending share explicitly', () => {
    stashPendingShare({ url: 'https://x.com/uniover/123' });
    expect(peekPendingShare()).not.toBeNull();

    clearPendingShare();
    expect(peekPendingShare()).toBeNull();
  });

  it('removes the stale session entry when the next write falls back to localStorage', () => {
    stashPendingShare({ url: 'https://example.org/first' });
    expect(sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY)).not.toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError');
    });

    stashPendingShare({ url: 'https://example.org/second' });

    expect(sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(PENDING_SHARE_STORAGE_KEY)!)).toMatchObject({
      url: 'https://example.org/second',
    });
  });

  it('preserves a newer share in memory and sessionStorage when clearing an older local copy', () => {
    const older = { id: 'older', timestamp: 1, url: 'https://example.org/first' };
    localStorage.setItem(PENDING_SHARE_STORAGE_KEY, JSON.stringify(older));
    stashPendingShare({ url: 'https://example.org/second' });
    const newer = peekPendingShare();

    clearPendingShare(older.id);

    expect(localStorage.getItem(PENDING_SHARE_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY)!)).toEqual(newer);
    sessionStorage.removeItem(PENDING_SHARE_STORAGE_KEY);
    expect(peekPendingShare()?.url).toBe('https://example.org/second');
  });

  it('falls back to memory when storage throws errors (e.g. private mode quota)', () => {
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    stashPendingShare({ url: 'https://vm.tiktok.com/123' });

    vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('StorageDisabled');
    });
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('StorageDisabled');
    });

    const pending = peekPendingShare();
    expect(pending?.url).toBe('https://vm.tiktok.com/123');

    clearPendingShare();
    expect(peekPendingShare()).toBeNull();
  });

  it('survives a reload via localStorage when sessionStorage fails and expires after an hour', () => {
    const denyAccess = () => {
      throw new Error('SecurityError');
    };
    const blockedSessionStorage: Storage = {
      length: 0,
      key: () => null,
      getItem: denyAccess,
      setItem: denyAccess,
      removeItem: denyAccess,
      clear: denyAccess,
    };
    vi.stubGlobal('sessionStorage', blockedSessionStorage);

    const timestamp = Date.now();
    stashPendingShare({ url: 'https://www.youtube.com/watch?v=abc', timestamp });

    // localStorage deve ter recebido o item como fallback
    const stored = localStorage.getItem(PENDING_SHARE_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).url).toBe('https://www.youtube.com/watch?v=abc');

    // Simula reload: limpa tudo, e reescreve em localStorage (como se ele tivesse sobrevivido ao reload)
    clearPendingShare();
    localStorage.setItem(PENDING_SHARE_STORAGE_KEY, stored!);

    // localStorage ainda devolve o item salvo antes do reload
    const peeked = peekPendingShare();
    expect(peeked).not.toBeNull();
    expect(peeked?.url).toBe('https://www.youtube.com/watch?v=abc');

    vi.spyOn(Date, 'now').mockReturnValue(timestamp + 60 * 60 * 1000 + 1);
    expect(peekPendingShare()).toBeNull();
    expect(localStorage.getItem(PENDING_SHARE_STORAGE_KEY)).toBeNull();
  });
});
