import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIDEOS_ROUTES } from './videos.routes';
import { authGuard } from '../../core/auth/auth.guard';
import { AuthService } from '../../core/auth/auth.service';
import { safeNextUrl } from '../../core/auth/next-url';
import { SessionState } from '../../core/session/session-state';
import {
  PENDING_SHARE_STORAGE_KEY,
  clearPendingShare,
  peekPendingShare,
  stashPendingShare,
} from './pending-share-storage';
import { MAX_SHARE_PARAM_LENGTH } from './share-input-limits';
import { ShareTargetPage } from './share-target.page';
import { VIDEO_INBOX_DB_FACTORY, VideoInboxDb } from './video-inbox-db';
import { VideoInboxService } from './video-inbox.service';

@Component({ template: '' })
class BlankComponent {}

describe('ShareTargetPage', () => {
  let authStatus: 'anonymous' | 'authenticated' | 'pending';
  let accountRole: 'owner' | 'guest' | null;
  let accountPermissions: readonly string[] | null;
  let currentAccountId: string | null;
  let fakeIdb: IDBFactory;

  let harness: RouterTestingHarness;

  async function open(url: string): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'videos/compartilhar', component: ShareTargetPage },
          { path: 'videos', canMatch: [authGuard], children: VIDEOS_ROUTES },
          { path: 'entrar', component: BlankComponent },
          { path: '', component: BlankComponent },
        ]),
        VideoInboxService,
        {
          provide: AuthService,
          useFactory: () => {
            const router = TestBed.inject(Router);
            return {
              init: async () => undefined,
              status: () => authStatus,
              // Mesmo filtro de `?next=` usado pelo login real.
              loginUrlTree: (next: string) =>
                router.createUrlTree(['/entrar'], {
                  queryParams: { next: safeNextUrl(next, 'http://localhost') },
                }),
            };
          },
        },
        {
          provide: SessionState,
          useValue: {
            role: () => accountRole,
            knownPermissions: () => accountPermissions,
            accountId: () => currentAccountId,
          },
        },
        {
          provide: VIDEO_INBOX_DB_FACTORY,
          useValue: (accountId: string) =>
            new VideoInboxDb(`share-test-${accountId}`, {
              indexedDB: fakeIdb,
              IDBKeyRange: FakeIDBKeyRange,
            }),
        },
      ],
    });

    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(TestBed.inject(Router).url).not.toContain('/videos/compartilhar');
      expect(harness.fixture.nativeElement.querySelector('.loading-state')).toBeNull();
    });
  }

  beforeEach(() => {
    fakeIdb = new FakeIDBFactory();
    authStatus = 'authenticated';
    accountRole = 'owner';
    accountPermissions = null;
    currentAccountId = 'test-account';
    clearPendingShare();
  });

  afterEach(() => {
    clearPendingShare();
  });

  it('stashes pending share and redirects to login when anonymous user shares', async () => {
    authStatus = 'anonymous';

    await open(
      '/videos/compartilhar?url=&text=Veja+https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ&title=Musica',
    );

    const pending = peekPendingShare();
    expect(pending).not.toBeNull();
    expect(pending?.text).toBe('Veja https://youtu.be/dQw4w9WgXcQ');
    expect(pending?.title).toBe('Musica');

    const router = TestBed.inject(Router);
    const next = router.parseUrl(router.url).queryParams['next'];
    expect(next).toBe(`/videos?share=${pending!.id}`);
    authStatus = 'authenticated';
    await router.navigateByUrl(next);
    const service = TestBed.inject(VideoInboxService);
    await vi.waitFor(async () => expect(await service.list()).toHaveLength(1));
    expect((await service.list())[0].canonical_url).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(peekPendingShare()).toBeNull();
  });

  it('captures share immediately and navigates to /videos when authenticated and authorized', async () => {
    authStatus = 'authenticated';
    accountRole = 'owner';

    await open(
      '/videos/compartilhar?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FC3abc123%2F&title=Reel',
    );

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/videos');

    const inboxService = TestBed.inject(VideoInboxService);
    const items = await inboxService.list();
    expect(items).toHaveLength(1);
    expect(items[0].canonical_url).toBe('https://www.instagram.com/reel/C3abc123/');
    expect(items[0].platform).toBe('instagram');
    expect(items[0].captured_via).toBe('share_target');
  });

  it('does not consume an unrelated pending share on empty share-target entry', async () => {
    stashPendingShare({
      url: 'https://x.com/uniover/status/1234567890',
      text: 'Texto pendente',
    });

    authStatus = 'authenticated';
    accountRole = 'owner';

    await open('/videos/compartilhar');

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/videos');

    const inboxService = TestBed.inject(VideoInboxService);
    const items = await inboxService.list();
    expect(items).toHaveLength(0);
    expect(peekPendingShare()?.url).toBe('https://x.com/uniover/status/1234567890');
  });

  it('does not stash a share whose url carries credentials', async () => {
    authStatus = 'anonymous';
    await open('/videos/compartilhar?url=https%3A%2F%2Fuser%3Asecret%40youtu.be%2Fabc');
    expect(peekPendingShare()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    const router = TestBed.inject(Router);
    expect(router.parseUrl(router.url).queryParams['next']).toBe('/videos');
  });

  it('preserves the share until account permissions are known', async () => {
    accountRole = null;
    await open('/videos/compartilhar?url=https%3A%2F%2Fyoutu.be%2Fabc');

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/');
    const pending = peekPendingShare();
    expect(pending?.url).toBe('https://youtu.be/abc');

    accountRole = 'guest';
    accountPermissions = ['module:videos'];
    await router.navigateByUrl(`/videos?share=${pending!.id}`);
    const service = TestBed.inject(VideoInboxService);
    await vi.waitFor(async () => expect(await service.list()).toHaveLength(1));
    expect(peekPendingShare()).toBeNull();
  });

  it.each([
    ['permissions', 'test-account'],
    ['account', null],
  ])(
    'saves a share interrupted by unknown %s on a later plain inbox visit',
    async (_, initialAccountId) => {
      accountRole = null;
      currentAccountId = initialAccountId;
      await open('/videos/compartilhar?url=https%3A%2F%2Fyoutu.be%2Fabc');
      const router = TestBed.inject(Router);
      expect(router.url).toBe('/');

      accountRole = 'owner';
      currentAccountId = 'test-account';
      await router.navigateByUrl('/videos');
      const service = TestBed.inject(VideoInboxService);
      await vi.waitFor(async () => expect(await service.list()).toHaveLength(1));
      await vi.waitFor(() => expect(sessionStorage.length).toBe(0));
      expect(peekPendingShare()).toBeNull();
    },
  );

  it('does not hand an interrupted share to another account', async () => {
    accountRole = null;
    await open('/videos/compartilhar?url=https%3A%2F%2Fyoutu.be%2Fabc');

    accountRole = 'owner';
    currentAccountId = 'other-account';
    await harness.navigateByUrl('/videos');
    // A lista vazia só aparece depois que a página terminou de processar a entrada.
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(harness.fixture.nativeElement.querySelector('.empty-state')).not.toBeNull();
    });
    const service = TestBed.inject(VideoInboxService);
    expect(await service.list()).toEqual([]);
    expect(peekPendingShare()?.url).toBe('https://youtu.be/abc');
  });

  it('resumes the interrupted share instead of the one written by another tab', async () => {
    accountRole = null;
    await open('/videos/compartilhar?url=https%3A%2F%2Fyoutu.be%2Fmine');
    const other = { id: 'other-tab', timestamp: Date.now(), url: 'https://youtu.be/other' };
    localStorage.setItem(PENDING_SHARE_STORAGE_KEY, JSON.stringify(other));

    accountRole = 'owner';
    await TestBed.inject(Router).navigateByUrl('/videos');
    const service = TestBed.inject(VideoInboxService);
    await vi.waitFor(async () => expect(await service.list()).toHaveLength(1));
    expect((await service.list())[0].raw_text).toBe('https://youtu.be/mine');
    expect(peekPendingShare(other.id)).not.toBeNull();
  });

  it('blocks guest without module:videos permission and redirects to home', async () => {
    authStatus = 'authenticated';
    accountRole = 'guest';
    accountPermissions = ['module:tv'];

    await open('/videos/compartilhar?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3D123');

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/');
    expect(peekPendingShare()).toBeNull();
  });

  it('truncates parameters exceeding MAX_SHARE_PARAM_LENGTH before stashing', async () => {
    authStatus = 'authenticated';
    accountRole = 'owner';

    const oversized = 'A'.repeat(MAX_SHARE_PARAM_LENGTH + 500);
    const urlSafe = encodeURIComponent(oversized);
    await open(`/videos/compartilhar?text=${urlSafe}&title=${urlSafe}`);

    const pending = peekPendingShare();
    // The authenticated owner flow processes (consumes) the pending share
    // immediately, so it must be null after navigation completes.
    expect(pending).toBeNull();
    const { clampShareParam } = await import('./share-input-limits');
    const truncated = clampShareParam(oversized)!;
    expect(truncated.length).toBe(MAX_SHARE_PARAM_LENGTH);
    expect(truncated).toBe(oversized.slice(0, MAX_SHARE_PARAM_LENGTH));
  });

  it('does not throw or hang when receiving very large share parameters', async () => {
    authStatus = 'authenticated';
    accountRole = 'owner';

    const huge = 'https://youtu.be/abc ' + 'x'.repeat(MAX_SHARE_PARAM_LENGTH * 2);
    const urlSafe = encodeURIComponent(huge);
    await open(`/videos/compartilhar?text=${urlSafe}`);

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/videos');
  });

  describe('unsafe protocol rejection in share target', () => {
    it('does not stash pending share when url has javascript: scheme', async () => {
      authStatus = 'anonymous';
      await open('/videos/compartilhar?url=javascript%3Aalert(1)');
      expect(peekPendingShare()).toBeNull();
    });

    it('does not stash pending share when text has javascript: scheme', async () => {
      authStatus = 'anonymous';
      await open('/videos/compartilhar?text=javascript%3Aalert(document.cookie)');
      expect(peekPendingShare()).toBeNull();
    });

    it('does not stash pending share when url has data: scheme', async () => {
      authStatus = 'anonymous';
      await open(
        '/videos/compartilhar?url=data%3Atext%2Fhtml%2C%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      );
      expect(peekPendingShare()).toBeNull();
    });

    it('does not stash pending share when url has blob: scheme', async () => {
      authStatus = 'anonymous';
      await open('/videos/compartilhar?url=blob%3Ahttps%3A%2F%2Fexample.com%2Fuuid');
      expect(peekPendingShare()).toBeNull();
    });

    it('does not stash pending share when url has file: scheme', async () => {
      authStatus = 'anonymous';
      await open('/videos/compartilhar?url=file%3A%2F%2F%2Fetc%2Fpasswd');
      expect(peekPendingShare()).toBeNull();
    });

    it('does not save to storage when authenticated and url has javascript: scheme', async () => {
      authStatus = 'authenticated';
      accountRole = 'owner';
      await open('/videos/compartilhar?url=javascript%3Aalert(1)');
      const inboxService = TestBed.inject(VideoInboxService);
      expect(await inboxService.list()).toHaveLength(0);
    });
  });
});
