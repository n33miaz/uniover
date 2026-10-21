import { TestBed } from '@angular/core/testing';
import type { InstallEnvInput } from '../../../core/pwa/install-env';
import { INSTALL_ENV, InstallHintService } from '../../../core/pwa/install-hint.service';
import { SessionRepository } from '../data/sessions/session-repository';
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
});
