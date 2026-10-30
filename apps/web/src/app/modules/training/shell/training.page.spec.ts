import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { InstallEnvInput } from '../../../core/pwa/install-env';
import { INSTALL_ENV, InstallHintService } from '../../../core/pwa/install-hint.service';
import { SessionRepository } from '../data/sessions/session-repository';
import { NEW_ITEM } from '../../../core/offline-queue/queue-test-kit';
import { eventually, setupScreen } from './screen-test-kit';
import { SessionState } from '../../../core/session/session-state';
import { TrainingHeaderActions } from './training-header-actions';
import { TrainingPage } from './training.page';
import { vi } from 'vitest';

describe('TrainingPage: the install sheet and the open workout', () => {
  afterEach(() => {
    document.body.removeAttribute('tabindex');
    vi.unstubAllGlobals();
  });
  const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const SAFARI: InstallEnvInput = {
    userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`,
  };

  async function render(
    beforeRender?: (repository: SessionRepository) => Promise<unknown>,
    env: InstallEnvInput = SAFARI,
  ) {
    const kit = await setupScreen([], [{ provide: INSTALL_ENV, useValue: env }]);
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

  it('has one top back button, no sync button, and shows the exact title', async () => {
    const { fixture } = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('app-page-top-bar h1')?.textContent).toBe('Treino');
    expect(el.querySelectorAll('app-page-top-bar .back')).toHaveLength(1);
    expect(el.querySelector('app-training-sync-line .advice')).toBeNull();
    expect(el.querySelector('.status')).toBeNull();
    expect(el.querySelector('[aria-label="Mais opções"]')).toBeNull();
  });

  it('shows a refused change as a red ring beside the three dots, opens a short sheet, and keeps it out of the menu', async () => {
    const { fixture, queue, store } = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('app-training-sync-ring')).toBeNull();
    const id = await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await store().markFailed(id, (await store().get(id))!.revision, 'http-422');
    await eventually(fixture, () =>
      expect(
        el.querySelector('.pill app-training-sync-ring .ring[data-state="failed"]'),
      ).not.toBeNull(),
    );
    // Só o anel (sem ações de tela): a pílula tem o anel, e o menu não ganha o item de problemas.
    expect(el.querySelector('[aria-label="Mais opções"]')).toBeNull();
    const ring = el.querySelector<HTMLButtonElement>('.ring')!;
    ring.click();
    fixture.detectChanges();
    expect(document.body.textContent).toContain('O servidor recusou alterações.');
    const see = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(
      (button) => button.textContent?.includes('Ver os Recusados'),
    )!;
    expect(
      Array.from(document.querySelectorAll('dialog button')).map((b) => b.textContent),
    ).toEqual(expect.arrayContaining([expect.stringContaining('Tentar de Novo')]));
    see.click();
    fixture.detectChanges();
    expect(el.querySelector('app-sync-issues-sheet')).not.toBeNull();
  });

  it('shows the actions a screen registers in the single top menu and drops them when the screen leaves', async () => {
    const { fixture } = await render();
    const el = fixture.nativeElement as HTMLElement;
    const run = vi.fn();
    const remove = TestBed.inject(TrainingHeaderActions).register({
      id: 'screen-menu',
      label: 'Opções do treino',
      run,
    });
    await eventually(fixture, () =>
      expect(el.querySelectorAll('app-page-top-bar [aria-label="Mais opções"]')).toHaveLength(1),
    );
    el.querySelector<HTMLButtonElement>('[aria-label="Mais opções"]')!.click();
    fixture.detectChanges();
    const item = Array.from(el.querySelectorAll<HTMLButtonElement>('.menu-actions button')).find(
      (button) => button.textContent?.includes('Opções do treino'),
    )!;
    item.click();
    expect(run).toHaveBeenCalledOnce();

    remove();
    await eventually(fixture, () =>
      expect(el.querySelector('[aria-label="Mais opções"]')).toBeNull(),
    );
  });

  it('sends the single top back to the screen handler when there is one, and to the logical parent otherwise', async () => {
    const { fixture } = await render();
    const el = fixture.nativeElement as HTMLElement;
    const handler = vi.fn();
    const remove = TestBed.inject(TrainingHeaderActions).registerBack(handler);
    el.querySelector<HTMLButtonElement>('app-page-top-bar .back')!.click();
    expect(handler).toHaveBeenCalledOnce();
    remove();
  });

  it('restores focus between exercise routes while reduced motion disables the slide', async () => {
    await setupScreen();
    const fixture = TestBed.createComponent(TrainingPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const component = fixture.componentInstance as unknown as { animateRoute(): void };
    const router = TestBed.inject(Router);
    let path = '/treino/exercicios';
    vi.spyOn(router, 'url', 'get').mockImplementation(() => path);
    const outlet = (fixture.nativeElement as HTMLElement).querySelector('router-outlet')!;
    const page = document.createElement('section');
    const selector = document.createElement('nav');
    const selectedLink = document.createElement('a');
    selector.className = 'seg';
    selectedLink.setAttribute('aria-current', 'page');
    selectedLink.href = '/treino/rotinas';
    page.className = 'route-page';
    selector.append(selectedLink);
    page.append(selector);
    outlet.insertAdjacentElement('afterend', page);
    const animate = vi.fn();
    page.animate = animate;
    let reducedMotion = true;
    document.body.tabIndex = -1;
    document.body.focus();
    // Só a consulta de movimento reduzido responde; as demais (modo de exibição do app instalado) seguem como "não".
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion') && reducedMotion,
    }));

    component.animateRoute();
    path = '/treino/rotinas';
    component.animateRoute();

    expect(document.activeElement).toBe(selectedLink);
    expect(animate).not.toHaveBeenCalled();

    reducedMotion = false;
    path = '/treino/exercicios';
    component.animateRoute();
    expect(animate.mock.calls[0][0][0]).toMatchObject({ transform: 'translateX(-18px)' });
    path = '/treino/rotinas';
    component.animateRoute();
    expect(animate.mock.calls[1][0][0]).toMatchObject({ transform: 'translateX(18px)' });
  });

  describe('no app instalado do Treino (escopo /treino/)', () => {
    const INSTALLED: InstallEnvInput = { ...SAFARI, standalone: true };
    const guest = (permissions: string[]) =>
      ({ id: '1', email: 'a@b.c', displayName: 'A', role: 'guest', permissions }) as const;
    const back = (fixture: { nativeElement: unknown }) =>
      (fixture.nativeElement as HTMLElement).querySelector('app-page-top-bar .back');

    it('quem só tem o Treino não vê a seta na raiz das abas: a Início fica fora do app', async () => {
      const { fixture } = await render(undefined, INSTALLED);
      TestBed.inject(SessionState).setUser(guest(['module:training']));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(back(fixture)).toBeNull();
    });

    it('quem tem a TV e o Treino, e o dono, continuam com a seta para trocar de módulo', async () => {
      const { fixture } = await render(undefined, INSTALLED);
      const session = TestBed.inject(SessionState);
      session.setUser(guest(['module:training', 'module:tv']));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(back(fixture)).not.toBeNull();
      session.setUser({ id: '1', email: 'a@b.c', displayName: 'A', role: 'owner' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(back(fixture)).not.toBeNull();
    });

    it('no navegador comum quem só tem o Treino volta à Início', async () => {
      const { fixture } = await render();
      TestBed.inject(SessionState).setUser(guest(['module:training']));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(back(fixture)).not.toBeNull();
    });
  });
});
