import { TestBed } from '@angular/core/testing';
import type { InstallEnvInput } from '../../../core/pwa/install-env';
import { INSTALL_ENV, InstallHintService } from '../../../core/pwa/install-hint.service';
import { SessionRepository } from '../data/sessions/session-repository';
import { SessionState } from '../../../core/session/session-state';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { eventually, setupScreen } from './screen-test-kit';
import { TrainingPage } from './training.page';

describe('TrainingPage: the install sheet and the open workout', () => {
  const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const SAFARI: InstallEnvInput = {
    userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`,
  };

  async function render(beforeRender?: (repository: SessionRepository) => Promise<unknown>) {
    const kit = await setupScreen([], [{ provide: INSTALL_ENV, useValue: SAFARI }]);
    const repository = TestBed.inject(SessionRepository);
    await beforeRender?.(repository);
    const fixture = TestBed.createComponent(TrainingPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return { ...kit, fixture, repository, hint: TestBed.inject(InstallHintService) };
  }

  it('asks nothing of the sheet while there is no open workout', async () => {
    const { hint, fixture } = await render();
    await fixture.whenStable();
    expect(hint.autoHeld()).toBe(false);
    expect(hint.autoEligible()).toBe(true);
  });

  it('holds the sheet while a workout is open and lets it go when the workout ends', async () => {
    const { hint, fixture, repository } = await render();

    await repository.start();
    await eventually(fixture, () => expect(hint.autoHeld()).toBe(true));
    expect(hint.autoEligible()).toBe(false);

    await repository.finish();
    await eventually(fixture, () => expect(hint.autoHeld()).toBe(false));
    expect(hint.autoEligible()).toBe(true);
  });

  it('holds the sheet right away when the app reopens in the middle of a workout', async () => {
    const { hint, fixture } = await render((repository) => repository.start());
    await eventually(fixture, () => expect(hint.autoHeld()).toBe(true));
  });

  it('lets the hold go when the person discards the workout', async () => {
    const { hint, fixture, repository } = await render((repository) => repository.start());
    await eventually(fixture, () => expect(hint.autoHeld()).toBe(true));
    await repository.discard();
    await eventually(fixture, () => expect(hint.autoHeld()).toBe(false));
  });

  it('lets the hold go when the person leaves the module', async () => {
    const { hint, fixture } = await render((repository) => repository.start());
    await eventually(fixture, () => expect(hint.autoHeld()).toBe(true));
    fixture.destroy();
    expect(hint.autoHeld()).toBe(false);
  });

  it('never opens the sheet by itself during the workout, but the person can still ask for it', async () => {
    const { hint, fixture } = await render((repository) => repository.start());
    await eventually(fixture, () => expect(hint.autoOpenAllowed()).toBe(false));
    hint.open();
    expect(hint.sheet()).toBe('manual');
  });

  it('shows the module title and opens sync details from the date indicator', async () => {
    const { fixture } = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('UniOver Treino');
    const indicator = el.querySelector<HTMLButtonElement>('.training-header .status')!;
    expect(indicator.getAttribute('aria-expanded')).toBe('false');
    TestBed.inject(ConnectivityService).online.set(false);
    await fixture.whenStable();
    expect(indicator.classList.contains('offline')).toBe(true);
    indicator.click();
    await fixture.whenStable();
    expect(indicator.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('app-training-sync-line')?.textContent).toContain('Sem rede');
  });

  it('only offers a way back when another module is available', async () => {
    const { fixture } = await render();
    const el = fixture.nativeElement as HTMLElement;
    const session = TestBed.inject(SessionState);
    session.setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'guest',
      permissions: ['module:training'],
    });
    await fixture.whenStable();
    expect(el.querySelector('.training-header .back')).toBeNull();
    expect(el.querySelector('.training-header .settings')?.getAttribute('href')).toBe('/ajustes');
    session.setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'guest',
      permissions: ['module:training', 'module:tv'],
    });
    await fixture.whenStable();
    expect(el.querySelector('.training-header .back')?.getAttribute('href')).toBe('/tv');
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'A', role: 'owner' });
    await fixture.whenStable();
    expect(el.querySelector('.training-header .back')?.getAttribute('href')).toBe('/');
  });
});
