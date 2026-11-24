import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingShare,
  peekPendingShare,
  PENDING_SHARE_STORAGE_KEY,
  stashPendingShare,
} from './pending-share-storage';

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

  it('survives a reload via localStorage when sessionStorage fails', () => {
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

    stashPendingShare({ url: 'https://www.youtube.com/watch?v=abc' });

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
  });
});
