import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { PowerSheet } from './power-sheet';

function clickBackdrop(dialog: HTMLDialogElement): void {
  Object.defineProperty(dialog, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 10, top: 10, right: 300, bottom: 500 }),
  });
  dialog.dispatchEvent(
    Object.assign(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0 }), {
      isPrimary: true,
    }),
  );
  dialog.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
}

describe('PowerSheet', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PowerSheet>>;
  let root: HTMLElement;
  let closed: ReturnType<typeof vi.fn<() => void>>;

  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const named = (name: string) => buttons().find((b) => b.textContent?.trim() === name)!;

  beforeEach(async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(PowerSheet);
    closed = vi.fn<() => void>();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    root = fixture.nativeElement;
  });

  it('opens as a modal sheet with the question and the warning', () => {
    const dialog = root.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe('Desligar a TV?');
    expect(root.textContent).toContain(
      'Sem o emissor infravermelho, a TV só volta com o controle original.',
    );
    expect(dialog.getAttribute('aria-labelledby')).toBe('power-title');
  });

  it('explains the reading only for an agent that does it, and describes the dialog with it', async () => {
    const dialog = root.querySelector('dialog')!;
    expect(root.textContent).not.toContain('O agente só desliga se a TV estiver ligada');
    expect(dialog.getAttribute('aria-describedby')).toBe('power-text');

    store.safePowerOff.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(root.querySelector('#power-checked')?.textContent).toContain(
      'O agente só desliga se a TV estiver ligada e confirma o resultado.',
    );
    expect(dialog.getAttribute('aria-describedby')).toBe('power-text power-checked');
  });

  it('keeps the power confirmation at the end of the sheet', () => {
    expect(
      buttons()
        .slice(-2)
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Cancelar', 'Desligar']);
  });

  describe('Agendar desligamento', () => {
    const row = () => root.querySelector<HTMLElement>('.schedule')!;

    it('shows why scheduling is unavailable without a safe online agent', () => {
      expect(row().textContent).toContain('Agendar desligamento');
      expect(row().textContent).toContain('Agendamento disponível com TV configurada');
      expect(row().querySelector('button, input')).toBeNull();
    });

    it('confirms the local date and time before saving', async () => {
      store.canSchedulePowerOff.set(true);
      fixture.detectChanges();
      named('30 min').click();
      fixture.detectChanges();
      expect(row().textContent).toContain('Desligar em');
      named('Confirmar agendamento').click();
      await fixture.whenStable();
      expect(store.savePowerSchedule).toHaveBeenCalledOnce();
      const [dueAtUtc, zone] = store.savePowerSchedule.mock.calls[0];
      expect(new Date(dueAtUtc).getTime()).toBeGreaterThan(Date.now());
      expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(closed).not.toHaveBeenCalled();
      expect(store.powerOff).not.toHaveBeenCalled();
    });

    it('shows the active schedule and cancels it without sending POWER', async () => {
      store.powerSchedule.set({
        id: 'schedule',
        dueAtUtc: new Date(Date.now() + 3600_000).toISOString(),
        timeZone: 'America/Sao_Paulo',
        status: 'pending',
        result: null,
        reason: null,
        version: 2,
      });
      fixture.detectChanges();
      named('Cancelar agendamento').click();
      await fixture.whenStable();
      expect(store.cancelPowerSchedule).toHaveBeenCalledOnce();
      expect(store.powerOff).not.toHaveBeenCalled();
    });

    it('shows the last dispatch result discreetly', () => {
      store.lastPowerSchedule.set({
        id: 'anterior',
        dueAtUtc: new Date().toISOString(),
        timeZone: 'America/Sao_Paulo',
        status: 'completed',
        result: 'uncertain',
        reason: null,
        version: 3,
      });
      fixture.detectChanges();
      expect(root.querySelector('.schedule-result')?.textContent).toContain('Estado incerto');
    });

    it('sits above the buttons, so the confirmation stays the last thing the eye reaches', () => {
      const footer = root.querySelector('.footer')!;
      expect(row().compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('Cancelar closes without sending anything', () => {
    named('Cancelar').click();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(store.powerOff).not.toHaveBeenCalled();
  });

  it('Esc cancels the same way, and stops the browser from closing it twice', () => {
    const event = new Event('cancel', { cancelable: true });
    root.querySelector('dialog')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(store.powerOff).not.toHaveBeenCalled();
  });

  it('a touch that begins and ends on the backdrop cancels the same way', () => {
    clickBackdrop(root.querySelector('dialog')!);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(store.powerOff).not.toHaveBeenCalled();
  });

  it('closes the dialog before notifying the page and returns focus to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const second = TestBed.createComponent(PowerSheet);
    second.detectChanges();
    await second.whenStable();
    const dialog = (second.nativeElement as HTMLElement).querySelector('dialog')!;
    const secondClosed = vi.fn<() => void>();
    second.componentInstance.closed.subscribe(() => {
      expect(dialog.open).toBe(false);
      secondClosed();
    });

    clickBackdrop(dialog);

    expect(secondClosed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('Desligar asks once and closes when it worked', async () => {
    named('Desligar').click();
    await fixture.whenStable();
    expect(store.powerOff).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('keeps the sheet open and shows the reason inside it when the TV does not answer', async () => {
    store.powerOff.mockResolvedValueOnce({
      kind: 'timeout',
      message: 'A TV não respondeu a tempo. Tente de novo.',
      retryAfterSeconds: null,
    });
    named('Desligar').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(closed).not.toHaveBeenCalled();
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('A TV não respondeu a tempo. Tente de novo.');
    expect(named('Desligar').disabled).toBe(false);
  });

  it('blocks both buttons while the request is going', async () => {
    let release!: () => void;
    store.powerOff.mockReturnValueOnce(new Promise((resolve) => (release = () => resolve(null))));
    named('Desligar').click();
    fixture.detectChanges();
    expect(named('Desligar').disabled).toBe(true);
    expect(named('Cancelar').disabled).toBe(true);
    named('Desligar').click();
    expect(store.powerOff).toHaveBeenCalledTimes(1);
    release();
    await fixture.whenStable();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('cannot confirm while the remote cannot send', () => {
    store.canSend.set(false);
    fixture.detectChanges();
    expect(named('Desligar').disabled).toBe(true);
  });
});

describe('PowerSheet leaving smoothly', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PowerSheet>>;
  let root: HTMLElement;
  let closed: ReturnType<typeof vi.fn<() => void>>;

  const named = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === name,
    )!;
  const dialog = () => root.querySelector('dialog')!;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // O jsdom não resolve o CSS: simula a transição de 200 ms da folha.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = real(element, pseudo);
      return new Proxy(style, {
        get: (target, key) =>
          key === 'transitionDuration' ? '0.2s, 0.2s' : (Reflect.get(target, key) as unknown),
      });
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(PowerSheet);
    closed = vi.fn<() => void>();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Cancelar starts the exit and only emits closed when the transition ends', () => {
    named('Cancelar').click();
    expect(dialog().hasAttribute('data-closing')).toBe(true);
    expect(closed).not.toHaveBeenCalled();

    dialog().dispatchEvent(new Event('transitionend'));
    expect(closed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('ignores the end of a transition that is not the sheet own (the backdrop one bubbles up)', () => {
    named('Cancelar').click();
    const inner = document.createElement('span');
    dialog().appendChild(inner);
    inner.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(closed).not.toHaveBeenCalled();
  });

  it('does not wait forever: after the safety limit it closes even if no transition ever ends', () => {
    named('Cancelar').click();
    vi.advanceTimersByTime(299);
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes at once for who asked for less motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    named('Cancelar').click();
    expect(dialog().hasAttribute('data-closing')).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('after a successful power off, waits for the exit and cannot ask again while it fades', async () => {
    named('Desligar').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.powerOff).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
    expect(dialog().hasAttribute('data-closing')).toBe(true);

    named('Desligar').click();
    named('Cancelar').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.powerOff).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('a failed power off does not start the exit: the reason shows inside the open sheet', async () => {
    store.powerOff.mockResolvedValueOnce({
      kind: 'timeout',
      message: 'A TV não respondeu a tempo. Tente de novo.',
      retryAfterSeconds: null,
    });
    named('Desligar').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(dialog().hasAttribute('data-closing')).toBe(false);
    expect(closed).not.toHaveBeenCalled();
  });
});
