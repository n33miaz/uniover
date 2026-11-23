import { TestBed } from '@angular/core/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionState } from '../../core/session/session-state';
import { clearPendingShare, stashPendingShare } from './pending-share-storage';
import { VIDEO_INBOX_DB_FACTORY, VideoInboxDb } from './video-inbox-db';
import type { VideoInboxItem } from './video-inbox.model';
import { VideoInboxService } from './video-inbox.service';

describe('VideoInboxService', () => {
  let service: VideoInboxService;
  let fakeSession: { accountId: () => string | null };

  beforeEach(() => {
    const fakeIdb = new FakeIDBFactory();
    fakeSession = { accountId: () => 'test-account-1' };

    TestBed.configureTestingModule({
      providers: [
        VideoInboxService,
        { provide: SessionState, useValue: fakeSession },
        {
          provide: VIDEO_INBOX_DB_FACTORY,
          useValue: (accountId: string) =>
            new VideoInboxDb(`test-inbox-${accountId}`, {
              indexedDB: fakeIdb,
              IDBKeyRange: FakeIDBKeyRange,
            }),
        },
      ],
    });

    service = TestBed.inject(VideoInboxService);
    clearPendingShare();
  });

  afterEach(() => {
    clearPendingShare();
  });

  it('lists items ordered by captured_at descending', async () => {
    const item1: VideoInboxItem = {
      id: 'item-1',
      canonical_url: 'https://www.youtube.com/watch?v=1',
      platform: 'youtube',
      captured_at: '2026-11-20T10:00:00.000Z',
      raw_text: 'Link 1',
      captured_via: 'share_target',
      status: 'link_only',
    };
    const item2: VideoInboxItem = {
      id: 'item-2',
      canonical_url: 'https://www.youtube.com/watch?v=2',
      platform: 'youtube',
      captured_at: '2026-11-21T10:00:00.000Z',
      raw_text: 'Link 2',
      captured_via: 'share_target',
      status: 'link_only',
    };

    await service.add(item1);
    await service.add(item2);

    const list = await service.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('item-2');
    expect(list[1].id).toBe('item-1');
  });

  it('deletes an item by id', async () => {
    const item: VideoInboxItem = {
      id: 'item-to-delete',
      canonical_url: 'https://www.instagram.com/reel/123/',
      platform: 'instagram',
      captured_at: new Date().toISOString(),
      raw_text: 'Reel',
      captured_via: 'share_target',
      status: 'link_only',
    };

    await service.add(item);
    expect(await service.list()).toHaveLength(1);

    await service.delete('item-to-delete');
    expect(await service.list()).toHaveLength(0);
  });

  it('captures share payload and stores normalized item', async () => {
    const captured = await service.captureShare({
      url: '',
      text: 'Veja esse video incrivel https://youtu.be/dQw4w9WgXcQ?si=abc',
      title: 'Never Gonna Give You Up',
    });

    expect(captured).not.toBeNull();
    expect(captured?.canonical_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(captured?.platform).toBe('youtube');
    expect(captured?.captured_via).toBe('share_target');
    expect(captured?.status).toBe('link_only');
    expect(captured?.raw_text).toBe('Veja esse video incrivel https://youtu.be/dQw4w9WgXcQ?si=abc');
    expect(captured?.title).toBe('Never Gonna Give You Up');

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0].canonical_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('returns null and does not save when payload has no valid URL', async () => {
    const result = await service.captureShare({
      text: 'Texto qualquer sem nenhum endereco',
    });
    expect(result).toBeNull();
    expect(await service.list()).toHaveLength(0);
  });

  it('keeps a pending share for retry and uses its capture time', async () => {
    const timestamp = Date.UTC(2026, 10, 21);
    stashPendingShare({ text: '', title: 'https://example.org/video', timestamp });
    fakeSession.accountId = () => null;
    await expect(service.processPendingShare()).rejects.toThrow();
    fakeSession.accountId = () => 'test-account-1';
    await Promise.all([service.processPendingShare(), service.processPendingShare()]);
    expect(await service.list()).toMatchObject([
      {
        raw_text: 'https://example.org/video',
        captured_at: new Date(timestamp).toISOString(),
      },
    ]);
    fakeSession.accountId = () => 'test-account-2';
    expect(await service.list()).toEqual([]);
  });

  it('processes pending share and clears it from storage', async () => {
    stashPendingShare({
      url: 'https://www.instagram.com/reel/C3abc123/?igsh=123',
      text: 'Reel compartilhado enquanto anonimo',
    });

    const processed = await service.processPendingShare();
    expect(processed).not.toBeNull();
    expect(processed?.canonical_url).toBe('https://www.instagram.com/reel/C3abc123/');
    expect(processed?.platform).toBe('instagram');

    const list = await service.list();
    expect(list).toHaveLength(1);

    const secondCall = await service.processPendingShare();
    expect(secondCall).toBeNull();
  });
});
