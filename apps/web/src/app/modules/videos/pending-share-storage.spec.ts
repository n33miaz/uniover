import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPendingShare, peekPendingShare, stashPendingShare } from './pending-share-storage';

describe('pending-share-storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    clearPendingShare();
  });

  afterEach(() => {
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
});
