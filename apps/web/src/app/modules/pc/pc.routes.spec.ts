import { TestBed } from '@angular/core/testing';
import {
  Router,
  UrlTree,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { PcAvailability } from '../../core/modules/pc-availability';
import { PcScreenAccess } from './data/screen-access';
import { screenGuard } from './pc.routes';

function setup(opts: { loaded: boolean; allowedAfterRead: boolean }) {
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
      { provide: PcScreenAccess, useValue: { allowed: () => allowed } },
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
});
