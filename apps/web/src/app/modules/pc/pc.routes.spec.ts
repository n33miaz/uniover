import { TestBed } from '@angular/core/testing';
import {
  GuardsCheckEnd,
  Router,
  UrlTree,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { PcAvailability } from '../../core/modules/pc-availability';
import { PcStore } from './data/pc-store';
import { PcScreenAccess } from './data/screen-access';
import { createFakePcStore } from './pc-test-kit';
import { PC_ROUTES, screenGuard } from './pc.routes';

function setup(opts: { loaded: boolean; allowedAfterRead: boolean; accountCanView?: boolean }) {
  let status: object | null = opts.loaded ? {} : null;
  let allowed = opts.loaded && opts.allowedAfterRead;
  let finish!: (ok: boolean) => void;
  const refresh = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = (ok) => {
          if (ok) {
            status = {};
            allowed = opts.allowedAfterRead;
          }
          resolve(ok);
        };
      }),
  );
  TestBed.configureTestingModule({
    providers: [
      { provide: PcAvailability, useValue: { status: () => status, refresh } },
      {
        provide: PcScreenAccess,
        useValue: { allowed: () => allowed, accountCanView: () => opts.accountCanView ?? true },
      },
    ],
  });
  const run = () =>
    TestBed.runInInjectionContext(() =>
      screenGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    ) as Promise<boolean | UrlTree>;
  return { refresh, run, finish: (ok = true) => finish(ok) };
}

describe('screenGuard', () => {
  it('waits for the first capability read before deciding on a direct link', async () => {
    const { refresh, run, finish } = setup({ loaded: false, allowedAfterRead: true });
    let result: boolean | UrlTree | undefined;
    const pending = run().then((value) => (result = value));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();

    finish();
    await pending;
    expect(result).toBe(true);
  });

  it('goes back to the mouse tab when the PC does not declare the capability', async () => {
    const { run, finish } = setup({ loaded: false, allowedAfterRead: false });
    const pending = run();
    finish();
    const result = await pending;
    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/pc');
  });

  it('goes back to the mouse tab when the read fails', async () => {
    const { run, finish } = setup({ loaded: false, allowedAfterRead: true });
    const pending = run();
    finish(false);
    expect(await pending).toBeInstanceOf(UrlTree);
  });

  it('does not read again when the capabilities are already known', async () => {
    const { refresh, run } = setup({ loaded: true, allowedAfterRead: true });
    expect(await run()).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('redirects an account without screen access without waiting for capabilities', async () => {
    const { refresh, run } = setup({
      loaded: false,
      allowedAfterRead: false,
      accountCanView: false,
    });
    const result = await run();
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/pc');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('PC entry route', () => {
  afterEach(() => vi.useRealTimers());

  it('opens the mouse page after the deadline when the first read never answers', async () => {
    const { refresh } = setup({ loaded: false, allowedAfterRead: true });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'pc', children: PC_ROUTES }]),
        { provide: PcStore, useValue: createFakePcStore() },
      ],
    });
    const harness = await RouterTestingHarness.create();
    const router = TestBed.inject(Router);
    const guardsChecked = vi.fn();
    router.events.subscribe((event) => {
      if (event instanceof GuardsCheckEnd) guardsChecked(event.shouldActivate);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const navigation = harness.navigateByUrl('/pc');

    await vi.advanceTimersByTimeAsync(1999);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(harness.routeNativeElement).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(guardsChecked).toHaveBeenCalledWith(true);
    await navigation;
    expect(router.url).toBe('/pc');
    expect(harness.routeNativeElement?.querySelector('app-pc-mouse-page')).toBeInstanceOf(
      HTMLElement,
    );
  });
});
