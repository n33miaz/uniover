import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import { FAILURE, FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PowerPage } from './power.page';

describe('PowerPage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PowerPage>>;
  let root: HTMLElement;

  const action = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('.action')].find(
      (b) => b.textContent?.trim() === name,
    )!;
  const sheet = () => root.querySelector<HTMLDialogElement>('dialog');
  const sheetButton = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.trim() === name,
    )!;

  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(() => {
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    fixture = TestBed.createComponent(PowerPage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('locks right away, with no confirmation', async () => {
    action('Bloquear').click();
    await settle();
    expect(store.power).toHaveBeenCalledExactlyOnceWith('LOCK', false);
    expect(sheet()).toBeNull();
  });

  it.each([
    ['Suspender', 'SLEEP', 'Suspender o PC?'],
    ['Desligar', 'SHUTDOWN', 'Desligar o PC?'],
  ])('%s asks first and only sends after the confirmation', async (label, code, title) => {
    action(label).click();
    await settle();
    expect(store.power).not.toHaveBeenCalled();
    expect(sheet()?.hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe(title);

    sheetButton(label).click();
    await settle();
    expect(store.power).toHaveBeenCalledExactlyOnceWith(code, true);
    expect(sheet()).toBeNull();
  });

  it('cancelling the sheet sends nothing', async () => {
    action('Desligar').click();
    await settle();
    sheetButton('Cancelar').click();
    await settle();
    expect(store.power).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it('keeps the sheet open and says why when the request failed', async () => {
    store.power.mockResolvedValueOnce(FAILURE);
    action('Suspender').click();
    await settle();
    sheetButton('Suspender').click();
    await settle();
    expect(sheet()).not.toBeNull();
    expect(root.querySelector('dialog .error')?.textContent).toContain('O PC está desconectado.');
  });

  it('after asking to shut down, offers to cancel the countdown, and cancelling hides it', async () => {
    expect(root.querySelector('.cancel')).toBeNull();
    action('Desligar').click();
    await settle();
    sheetButton('Desligar').click();
    await settle();
    const cancel = root.querySelector<HTMLButtonElement>('.cancel button')!;
    expect(cancel.textContent?.trim()).toBe('Cancelar Desligamento');

    cancel.click();
    await settle();
    expect(store.power).toHaveBeenLastCalledWith('CANCEL_SHUTDOWN', false);
    expect(root.querySelector('.cancel')).toBeNull();
  });

  const shutDown = async () => {
    action('Desligar').click();
    await settle();
    sheetButton('Desligar').click();
    await settle();
  };

  it.each([
    ['refused', 'O Windows recusou desligar. O PC segue ligado.'],
    ['lost', 'O agente do PC reiniciou no meio da contagem. O PC não vai desligar.'],
    ['cancelled', 'O desligamento foi cancelado na tela do PC.'],
  ] as const)(
    'stops offering the cancel and says why when the countdown was %s',
    async (outcome, text) => {
      await shutDown();
      expect(root.querySelector('.cancel')).not.toBeNull();

      store.powerOutcome.set({
        countdownId: 'nova',
        action: 'SHUTDOWN',
        outcome,
        at: '2026-11-21T14:00:30Z',
      });
      await settle();
      expect(root.querySelector('.cancel')).toBeNull();
      expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe(text);
    },
  );

  it('an outcome that was already there when the countdown began never hides it', async () => {
    store.powerOutcome.set({
      countdownId: 'antiga',
      action: 'SHUTDOWN',
      outcome: 'refused',
      at: '2026-11-21T13:00:00Z',
    });
    await shutDown();
    expect(root.querySelector('.cancel')).not.toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();

    // A API apaga o desfecho antigo com a contagem nova: sumir não é desfecho nenhum.
    store.powerOutcome.set(null);
    await settle();
    expect(root.querySelector('.cancel')).not.toBeNull();
  });

  it('an outcome with no countdown on the page changes nothing', async () => {
    store.powerOutcome.set({
      countdownId: 'nova',
      action: 'SHUTDOWN',
      outcome: 'lost',
      at: '2026-11-21T14:00:30Z',
    });
    await settle();
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('sleep does not offer the countdown cancellation', async () => {
    action('Suspender').click();
    await settle();
    sheetButton('Suspender').click();
    await settle();
    expect(root.querySelector('.cancel')).toBeNull();
  });

  it('shows a failure of a direct action on the page', async () => {
    store.power.mockResolvedValueOnce(FAILURE);
    action('Bloquear').click();
    await settle();
    expect(root.querySelector('.error.ui-notice.bad')?.textContent).toContain(
      'O PC está desconectado.',
    );
  });

  describe('with a PC that understands the newer power actions', () => {
    beforeEach(() => {
      store.capabilities.set(['pc.power.v2', 'pc.power.hibernate.v1']);
      fixture.detectChanges();
    });

    it('hides Hibernate from a PC with hibernation off, keeping the other newer actions', () => {
      store.capabilities.set(['pc.power.v2']);
      fixture.detectChanges();
      expect([...root.querySelectorAll('.action')].map((b) => b.textContent?.trim())).toEqual([
        'Bloquear',
        'Suspender',
        'Desligar',
        'Desligar o Monitor',
        'Reiniciar',
        'Encerrar Sessão',
      ]);
    });

    it('never shows Hibernate from the hibernation capability alone', () => {
      store.capabilities.set(['pc.power.hibernate.v1']);
      fixture.detectChanges();
      expect(action('Hibernar')).toBeUndefined();
    });

    it('hides the four newer actions from a PC that did not declare them', () => {
      store.capabilities.set([]);
      fixture.detectChanges();
      expect([...root.querySelectorAll('.action')].map((b) => b.textContent?.trim())).toEqual([
        'Bloquear',
        'Suspender',
        'Desligar',
      ]);
    });

    it('lists all seven actions in order', () => {
      expect([...root.querySelectorAll('.action')].map((b) => b.textContent?.trim())).toEqual([
        'Bloquear',
        'Suspender',
        'Desligar',
        'Hibernar',
        'Desligar o Monitor',
        'Reiniciar',
        'Encerrar Sessão',
      ]);
    });

    it('turns the monitor off right away, with no confirmation', async () => {
      action('Desligar o Monitor').click();
      await settle();
      expect(store.power).toHaveBeenCalledExactlyOnceWith('MONITOR_OFF', false);
      expect(sheet()).toBeNull();
    });

    it.each([
      ['Hibernar', 'HIBERNATE', 'Hibernar o PC?'],
      ['Reiniciar', 'RESTART', 'Reiniciar o PC?'],
      ['Encerrar Sessão', 'LOGOFF', 'Encerrar a sessão do Windows?'],
    ])('%s asks first and only sends after the confirmation', async (label, code, title) => {
      action(label).click();
      await settle();
      expect(store.power).not.toHaveBeenCalled();
      expect(root.querySelector('h2')?.textContent).toBe(title);

      sheetButton(label).click();
      await settle();
      expect(store.power).toHaveBeenCalledExactlyOnceWith(code, true);
      expect(sheet()).toBeNull();
    });

    it('warns that logging off lets Windows ask to save and that the control needs a new sign in', async () => {
      action('Encerrar Sessão').click();
      await settle();
      const text = root.querySelector('dialog')?.textContent ?? '';
      expect(text).toContain('O Windows pode pedir para salvar o trabalho aberto.');
      expect(text).toContain('alguém entrar no Windows de novo');
    });

    it('a restart offers its own cancel button, and only a restart or a shutdown do', async () => {
      action('Hibernar').click();
      await settle();
      sheetButton('Hibernar').click();
      await settle();
      expect(root.querySelector('.cancel')).toBeNull();

      action('Reiniciar').click();
      await settle();
      sheetButton('Reiniciar').click();
      await settle();
      const cancel = root.querySelector<HTMLButtonElement>('.cancel button')!;
      expect(cancel.textContent?.trim()).toBe('Cancelar Reinício');
      cancel.click();
      await settle();
      expect(store.power).toHaveBeenLastCalledWith('CANCEL_SHUTDOWN', false);
      expect(root.querySelector('.cancel')).toBeNull();
    });

    it('a restart that Windows refused says so', async () => {
      action('Reiniciar').click();
      await settle();
      sheetButton('Reiniciar').click();
      await settle();
      store.powerOutcome.set({
        countdownId: 'nova',
        action: 'RESTART',
        outcome: 'refused',
        at: '2026-11-21T14:00:30Z',
      });
      await settle();
      expect(root.querySelector('.cancel')).toBeNull();
      expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'O Windows recusou reiniciar. O PC segue ligado.',
      );
    });
  });

  it('is all disabled while the PC is not connected', () => {
    store.phase.set('offline');
    fixture.detectChanges();
    expect([...root.querySelectorAll<HTMLButtonElement>('.action')].every((b) => b.disabled)).toBe(
      true,
    );
  });
});
