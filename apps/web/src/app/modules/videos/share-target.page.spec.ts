import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIDEOS_ROUTES } from './videos.routes';
import { authGuard } from '../../core/auth/auth.guard';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { clearPendingShare, peekPendingShare, stashPendingShare } from './pending-share-storage';
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
  let fakeIdb: IDBFactory;

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
              loginUrlTree: (next: string) =>
                router.createUrlTree(['/entrar'], { queryParams: { next } }),
            };
          },
        },
        {
          provide: SessionState,
          useValue: {
            role: () => accountRole,
            knownPermissions: () => accountPermissions,
            accountId: () => 'test-account',
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

    const harness = await RouterTestingHarness.create();
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
    expect(router.url).toBe('/entrar?next=%2Fvideos');
    authStatus = 'authenticated';
    await router.navigateByUrl('/videos');
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

  it('processes any previously pending share on authenticated entry', async () => {
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
    expect(items).toHaveLength(1);
    expect(items[0].canonical_url).toBe('https://x.com/uniover/status/1234567890');
    expect(peekPendingShare()).toBeNull();
  });

  it('preserves the share until account permissions are known', async () => {
    accountRole = null;
    await open('/videos/compartilhar?url=https%3A%2F%2Fyoutu.be%2Fabc');

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/');
    expect(peekPendingShare()?.url).toBe('https://youtu.be/abc');

    accountRole = 'guest';
    accountPermissions = ['module:videos'];
    await router.navigateByUrl('/videos');
    const service = TestBed.inject(VideoInboxService);
    await vi.waitFor(async () => expect(await service.list()).toHaveLength(1));
    expect(peekPendingShare()).toBeNull();
  });

  it('blocks guest without module:videos permission and redirects to home', async () => {
    authStatus = 'authenticated';
    accountRole = 'guest';
    accountPermissions = ['module:tv'];

    stashPendingShare({ url: 'https://youtube.com/watch?v=123' });

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
});
