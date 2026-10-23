import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import type { InstallEnvInput } from '../../../core/pwa/install-env';
import { INSTALL_ENV, InstallHintService } from '../../../core/pwa/install-hint.service';
import { NEW_ITEM } from '../../../core/offline-queue/queue-test-kit';
import { HttpErrorResponse } from '@angular/common/http';
import { TrainingSync } from '../data/sync/training-sync';
import { setupTraining } from '../data/sync/training-test-kit';
import { eventually, setupScreen } from './screen-test-kit';
import { TrainingSyncLine } from './training-sync-line';

describe('TrainingSyncLine', () => {
  async function render() {
    const kit = await setupScreen();
    const fixture = TestBed.createComponent(TrainingSyncLine);
    await fixture.whenStable();
    fixture.detectChanges();
    return { ...kit, fixture, el: fixture.nativeElement as HTMLElement };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('takes no height while it has nothing to say (the first pull has not started)', async () => {
    setupTraining().pause();
    const fixture = TestBed.createComponent(TrainingSyncLine);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.hidden).toBe(true);
    expect(el.querySelector('.line')).toBeNull();
  });

  it('stays hidden when up to date, and never says "Atualizando" while pulling', async () => {
    const { fixture, el } = await render();
    await eventually(fixture, () =>
      expect(TestBed.inject(TrainingSync).lastPullAt()).not.toBeNull(),
    );
    expect(el.hidden).toBe(true);
    expect(text(el)).toBe('');
    const pulling = TestBed.inject(TrainingSync).pullNow();
    fixture.detectChanges();
    expect(text(el)).not.toContain('Atualizando');
    await pulling;
  });

  it('stays hidden without network when nothing waits (the header icon says it)', async () => {
    const { fixture, el } = await render();
    TestBed.inject(ConnectivityService).online.set(false);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.hidden).toBe(true);
    expect(text(el)).toBe('');
  });

  it('says it keeps going with what is on the device when sets wait and there is no network', async () => {
    const { fixture, el, queue } = await render();
    await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    TestBed.inject(ConnectivityService).online.set(false);
    await eventually(fixture, () =>
      expect(text(el)).toContain('Sem rede: usando o que está no aparelho'),
    );
    expect(el.hidden).toBe(false);
    expect(el.querySelector('.line')?.classList.contains('warn')).toBe(true);
  });

  it('says so when the server did not answer the last pull and something waits', async () => {
    const { fixture, el, pull, queue } = await render();
    pull.script = [new HttpErrorResponse({ status: 503 })];
    await TestBed.inject(TrainingSync).pullNow();
    await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await eventually(fixture, () =>
      expect(text(el)).toContain('Sem resposta do servidor: usando o que está no aparelho'),
    );
  });

  it('offers "Sincronizar agora" when there is something waiting to be sent, and uses it', async () => {
    const { fixture, el, queue } = await render();
    await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await eventually(fixture, () => expect(text(el)).toContain('1 ainda não sincronizado'));
    const pull = vi.spyOn(TestBed.inject(TrainingSync), 'pullNow').mockResolvedValue();
    const action = el.querySelector<HTMLButtonElement>('.act')!;
    expect(action.textContent?.trim()).toBe('Sincronizar agora');
    action.click();
    expect(pull).toHaveBeenCalledOnce();
  });

  it('does not offer to send while there is no network', async () => {
    const { fixture, el, queue } = await render();
    await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    TestBed.inject(ConnectivityService).online.set(false);
    await eventually(fixture, () => expect(text(el)).toContain('ainda não sincronizado'));
    expect(el.querySelector('.act')).toBeNull();
  });

  it('shows what the server refused, with a button to see it, and tells the page', async () => {
    const { fixture, el, queue, store } = await render();
    const id = await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    const stored = (await store().get(id))!;
    await store().markFailed(id, stored.revision, 'http-422');
    const asked = vi.fn();
    fixture.componentInstance.issues.subscribe(asked);
    await eventually(fixture, () => expect(text(el)).toContain('1 com erro'));
    expect(el.querySelector('.line')?.classList.contains('bad')).toBe(true);
    const see = el.querySelector<HTMLButtonElement>('.act')!;
    expect(see.textContent?.trim()).toBe('Ver');
    see.click();
    expect(asked).toHaveBeenCalledOnce();
  });
});

describe('TrainingSyncLine: install advice (iPhone outside the home screen)', () => {
  const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const SAFARI = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`;
  const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
  const ADVICE =
    'Estes treinos estão salvos só neste navegador. Envie-os quando tiver internet; instale na tela de início para os próximos.';

  async function render(env: InstallEnvInput, live = false) {
    const kit = await setupScreen([], [{ provide: INSTALL_ENV, useValue: env }]);
    const fixture = TestBed.createComponent(TrainingSyncLine);
    fixture.componentRef.setInput('live', live);
    await fixture.whenStable();
    fixture.detectChanges();
    return { ...kit, fixture, el: fixture.nativeElement as HTMLElement };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const advice = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.advice');

  async function pendingOffline(kit: Awaited<ReturnType<typeof render>>) {
    await kit.queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    TestBed.inject(ConnectivityService).online.set(false);
    await eventually(kit.fixture, () => expect(text(kit.el)).toContain('ainda não sincronizado'));
  }

  it('says it, with a way to the steps, when sets wait on an iPhone browser and nothing can be sent', async () => {
    const kit = await render({ userAgent: SAFARI });
    await pendingOffline(kit);
    await eventually(kit.fixture, () => expect(text(kit.el)).toContain(ADVICE));
    const button = advice(kit.el)!;
    expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe(`${ADVICE} Ver como`);
    // Um único botão de ação na linha; a sugestão é o botão inteiro (alvo de toque da altura de um dedo).
    expect(kit.el.querySelectorAll('.act')).toHaveLength(0);

    const open = vi.spyOn(TestBed.inject(InstallHintService), 'open');
    button.click();
    expect(open).toHaveBeenCalledOnce();
    expect(TestBed.inject(InstallHintService).sheet()).toBe('manual');
  });

  it('says nothing without anything waiting, even offline on an iPhone', async () => {
    const kit = await render({ userAgent: SAFARI });
    TestBed.inject(ConnectivityService).online.set(false);
    await kit.fixture.whenStable();
    kit.fixture.detectChanges();
    expect(kit.el.hidden).toBe(true);
    expect(advice(kit.el)).toBeNull();
  });

  it('says nothing while the network works: the sets go up in seconds', async () => {
    const kit = await render({ userAgent: SAFARI });
    await kit.queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await eventually(kit.fixture, () => expect(text(kit.el)).toContain('ainda não sincronizado'));
    expect(advice(kit.el)).toBeNull();
  });

  it('says nothing in the installed app, on Android or on a computer', async () => {
    for (const env of [
      { userAgent: SAFARI, standalone: true },
      { userAgent: ANDROID },
      { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36' },
    ]) {
      TestBed.resetTestingModule();
      const kit = await render(env);
      await pendingOffline(kit);
      expect(advice(kit.el), JSON.stringify(env)).toBeNull();
    }
  });

  it('says nothing during an open workout (nothing to be done there)', async () => {
    const kit = await render({ userAgent: SAFARI }, true);
    await pendingOffline(kit);
    expect(advice(kit.el)).toBeNull();
    kit.fixture.componentRef.setInput('live', false);
    await eventually(kit.fixture, () => expect(advice(kit.el)).not.toBeNull());
  });

  it('gives way to "Ver" when the server refused something', async () => {
    const kit = await render({ userAgent: SAFARI });
    const id = await kit.queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    const stored = (await kit.store().get(id))!;
    await kit.store().markFailed(id, stored.revision, 'http-422');
    TestBed.inject(ConnectivityService).online.set(false);
    await eventually(kit.fixture, () => expect(text(kit.el)).toContain('1 com erro'));
    expect(kit.el.querySelector('.act')?.textContent?.trim()).toBe('Ver');
    expect(advice(kit.el)).toBeNull();
  });

  it('goes away on its own when the network comes back', async () => {
    const kit = await render({ userAgent: SAFARI });
    await pendingOffline(kit);
    await eventually(kit.fixture, () => expect(advice(kit.el)).not.toBeNull());
    TestBed.inject(ConnectivityService).online.set(true);
    await eventually(kit.fixture, () => expect(advice(kit.el)).toBeNull());
  });
});
