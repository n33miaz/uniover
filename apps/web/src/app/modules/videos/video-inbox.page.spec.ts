import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionState } from '../../core/session/session-state';
import { clearPendingShare, stashPendingShare } from './pending-share-storage';
import { VIDEO_INBOX_DB_FACTORY, VideoInboxDb } from './video-inbox-db';
import type { VideoInboxItem } from './video-inbox.model';
import { VideoInboxPage } from './video-inbox.page';
import { VideoInboxService } from './video-inbox.service';

describe('VideoInboxPage', () => {
  let fakeIdb: IDBFactory;
  let inboxService: VideoInboxService;

  beforeEach(() => {
    fakeIdb = new FakeIDBFactory();
    clearPendingShare();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'videos', component: VideoInboxPage }]),
        VideoInboxService,
        {
          provide: SessionState,
          useValue: {
            role: () => 'owner',
            knownPermissions: () => null,
            accountId: () => 'inbox-page-account',
          },
        },
        {
          provide: VIDEO_INBOX_DB_FACTORY,
          useValue: (accountId: string) =>
            new VideoInboxDb(`inbox-page-test-${accountId}`, {
              indexedDB: fakeIdb,
              IDBKeyRange: FakeIDBKeyRange,
            }),
        },
      ],
    });

    inboxService = TestBed.inject(VideoInboxService);
  });

  async function open(
    url = '/videos',
  ): Promise<{ harness: RouterTestingHarness; el: HTMLElement }> {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const el = harness.fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(el.querySelector('.loading-state')).toBeNull();
    });
    return { harness, el };
  }

  afterEach(() => {
    clearPendingShare();
    vi.restoreAllMocks();
  });

  it('displays empty state when no links have been saved yet', async () => {
    const { el } = await open();
    expect(el.querySelector('.empty-state')).not.toBeNull();
    expect(el.textContent).toContain('Nenhum link na caixa ainda');
  });

  it('renders saved links with platform chip, canonical url and metadata', async () => {
    const fakeItem: VideoInboxItem = {
      id: 'test-1',
      canonical_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      platform: 'youtube',
      captured_at: '2026-11-23T14:30:00.000Z',
      raw_text: 'Assista no YouTube https://youtu.be/dQw4w9WgXcQ',
      captured_via: 'share_target',
      status: 'link_only',
      title: 'Rick Astley',
    };

    const preDb = new VideoInboxDb('inbox-page-test-inbox-page-account', {
      indexedDB: fakeIdb,
      IDBKeyRange: FakeIDBKeyRange,
    });
    await preDb.items.put(fakeItem);

    const { el } = await open();

    const items = el.querySelectorAll('.item-card');
    expect(items).toHaveLength(1);
    expect(el.querySelector('.platform-chip')?.textContent?.trim()).toBe('YouTube');
    expect(el.querySelector('.item-title')?.textContent?.trim()).toBe('Rick Astley');
    expect(el.querySelector('.item-url')?.getAttribute('href')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(el.querySelector('.status-tag')?.textContent?.trim()).toBe('Apenas link');
    expect(el.querySelector('.via-tag')?.textContent?.trim()).toBe('Compartilhamento');
  });

  it('processes pending share automatically when page initializes', async () => {
    stashPendingShare({
      url: 'https://www.instagram.com/reel/C3abc123/',
      text: 'Reel pendente',
    });

    const { el } = await open();
    expect(el.querySelector('.notice')?.textContent?.trim()).toBe('Link salvo com sucesso!');

    const items = await inboxService.list();
    expect(items).toHaveLength(1);
    expect(items[0].canonical_url).toBe('https://www.instagram.com/reel/C3abc123/');
  });

  it('processes query parameters passed directly to /videos', async () => {
    const { el } = await open('/videos?url=https%3A%2F%2Fvm.tiktok.com%2FZM8abc%2F&text=TikTok');

    expect(el.querySelector('.notice')?.textContent?.trim()).toBe('Link salvo com sucesso!');
    const items = await inboxService.list();
    expect(items).toHaveLength(1);
    expect(items[0].platform).toBe('tiktok');
  });

  it('adds a link manually using the input field and button', async () => {
    const { harness, el } = await open();
    const input = el.querySelector('.add-input') as HTMLInputElement;
    const form = el.querySelector('.add-form') as HTMLFormElement;

    input.value = 'Veja https://x.com/uniover/status/1234567890';
    input.dispatchEvent(new Event('input'));
    harness.detectChanges();

    form.requestSubmit();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(el.querySelector('.notice')).not.toBeNull();
    });

    expect(el.querySelector('.notice')?.textContent?.trim()).toBe('Link salvo com sucesso!');
    const items = await inboxService.list();
    expect(items).toHaveLength(1);
    expect(items[0].platform).toBe('twitter');
    expect(items[0].captured_via).toBe('manual');
  });

  it('shows error notice when manual link addition contains no valid URL', async () => {
    const { harness, el } = await open();
    const input = el.querySelector('.add-input') as HTMLInputElement;
    const form = el.querySelector('.add-form') as HTMLFormElement;

    input.value = 'texto sem url';
    input.dispatchEvent(new Event('input'));
    harness.detectChanges();

    form.requestSubmit();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(el.querySelector('.notice')).not.toBeNull();
    });

    expect(el.querySelector('.notice')?.textContent?.trim()).toContain(
      'Nenhum link válido encontrado',
    );
  });

  it('deletes an item when clicking delete button', async () => {
    await inboxService.add({
      id: 'item-del',
      canonical_url: 'https://www.youtube.com/watch?v=1',
      platform: 'youtube',
      captured_at: new Date().toISOString(),
      raw_text: 'Link',
      captured_via: 'share_target',
      status: 'link_only',
    });

    const { harness, el } = await open();
    expect(el.querySelectorAll('.item-card')).toHaveLength(1);

    const deleteBtn = el.querySelector('.btn-delete') as HTMLButtonElement;
    deleteBtn.click();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(el.querySelector('.item-card')).toBeNull();
    });

    expect(el.querySelector('.notice')?.textContent?.trim()).toBe('Link removido da caixa.');
    expect(await inboxService.list()).toHaveLength(0);
  });

  it('copies link to clipboard when clicking copy link button', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });

    await inboxService.add({
      id: 'item-copy',
      canonical_url: 'https://www.youtube.com/watch?v=123',
      platform: 'youtube',
      captured_at: new Date().toISOString(),
      raw_text: 'Link',
      captured_via: 'share_target',
      status: 'link_only',
    });

    const { harness, el } = await open();
    const copyBtn = el.querySelector('.btn-copy') as HTMLButtonElement;
    copyBtn.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(writeTextMock).toHaveBeenCalledWith('https://www.youtube.com/watch?v=123');
    expect(copyBtn.textContent?.trim()).toBe('Copiado!');
  });
});
