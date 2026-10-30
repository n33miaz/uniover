import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import type { InstallEnvInput } from '../../../core/pwa/install-env';
import { INSTALL_ENV, InstallHintService } from '../../../core/pwa/install-hint.service';
import { NEW_ITEM } from '../../../core/offline-queue/queue-test-kit';
import { eventually, setupScreen } from './screen-test-kit';
import { TrainingSyncLine } from './training-sync-line';

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

  const advice = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.advice');

  async function pendingOffline(kit: Awaited<ReturnType<typeof render>>) {
    await kit.queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    TestBed.inject(ConnectivityService).online.set(false);
    await kit.fixture.whenStable();
    kit.fixture.detectChanges();
  }

  it('takes no height and shows no sync text while there is nothing to advise', async () => {
    const kit = await render({ userAgent: SAFARI });
    expect(kit.el.hidden).toBe(true);
    expect(kit.el.textContent?.trim()).toBe('');
    // Pendente com rede: o anel do cabeçalho diz; aqui nada aparece.
    await kit.queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await kit.fixture.whenStable();
    kit.fixture.detectChanges();
    expect(kit.el.hidden).toBe(true);
    expect(advice(kit.el)).toBeNull();
  });

  it('says it, with a way to the steps, when sets wait on an iPhone browser and nothing can be sent', async () => {
    const kit = await render({ userAgent: SAFARI });
    await pendingOffline(kit);
    await eventually(kit.fixture, () => expect(advice(kit.el)).not.toBeNull());
    expect(kit.el.hidden).toBe(false);
    const button = advice(kit.el)!;
    expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe(`${ADVICE} Ver Como`);

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

  it('gives way to the ring when the server refused something', async () => {
    const kit = await render({ userAgent: SAFARI });
    const id = await kit.queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    const stored = (await kit.store().get(id))!;
    await kit.store().markFailed(id, stored.revision, 'http-422');
    TestBed.inject(ConnectivityService).online.set(false);
    await kit.fixture.whenStable();
    kit.fixture.detectChanges();
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
