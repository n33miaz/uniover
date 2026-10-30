import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeTv } from '../tv-test-kit';
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

  it('names the TV that will receive the shutdown only when there is more than one', () => {
    store.tvs.set([makeTv('sala', { name: 'Sala' })]);
    fixture.detectChanges();
    expect(root.querySelector('.target')).toBeNull();

    store.tvs.set([makeTv('sala', { name: 'Sala' }), makeTv('quarto', { name: 'Quarto' })]);
    fixture.detectChanges();
    expect(root.querySelector('.target')?.textContent?.trim()).toBe('Para: Sala');
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

  it('puts the one destructive action first and big, then the schedule, and Cancelar last', () => {
    const order = buttons().map((b) => b.textContent?.trim());
    expect(order[0]).toBe('Desligar');
    expect(order.at(-1)).toBe('Cancelar');
    expect(root.querySelector('button.danger.now')).not.toBeNull();
    // A ação destrutiva é a única vermelha, e a folha começa com o foco em Cancelar, nunca nela.
    expect(root.querySelectorAll('button.danger')).toHaveLength(1);
    expect(document.activeElement).toBe(named('Cancelar'));
  });

  describe('Agendar', () => {
    const row = () => root.querySelector<HTMLElement>('.schedule')!;
    const chip = (name: string) =>
      [...row().querySelectorAll<HTMLButtonElement>('.chip')].find(
        (b) => b.textContent?.trim() === name,
      )!;
    const confirm = () => row().querySelector<HTMLButtonElement>('.schedule-confirm')!;

    it('shows why scheduling is unavailable without a safe online agent', () => {
      expect(row().textContent).toContain('Agendar');
      expect(row().textContent).toContain('Agendamento disponível com TV configurada');
      expect(row().querySelector('button, input')).toBeNull();
    });

    it('offers quick times as chips: 15 min, 30 min, 1 h, 2 h and Personalizar', () => {
      store.canSchedulePowerOff.set(true);
      fixture.detectChanges();
      expect([...row().querySelectorAll('.chip')].map((b) => b.textContent?.trim())).toEqual([
        '15 min',
        '30 min',
        '1 h',
        '2 h',
        'Personalizar',
      ]);
      expect(row().querySelector('input[type="time"]')).toBeNull();
    });

    it('a chip marks itself as chosen and offers the time it would shut down at', () => {
      store.canSchedulePowerOff.set(true);
      fixture.detectChanges();
      expect(confirm()).toBeNull();
      chip('15 min').click();
      fixture.detectChanges();
      expect(chip('15 min').getAttribute('aria-pressed')).toBe('true');
      expect(chip('30 min').getAttribute('aria-pressed')).toBe('false');
      const clock = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' }).format(
        new Date(Date.now() + 15 * 60_000),
      );
      expect(confirm().textContent?.trim()).toBe('Agendar para ' + clock);
    });

    it('each chip schedules its own number of minutes, from now', async () => {
      store.canSchedulePowerOff.set(true);
      fixture.detectChanges();
      for (const [name, minutes] of [
        ['15 min', 15],
        ['30 min', 30],
        ['1 h', 60],
        ['2 h', 120],
      ] as const) {
        store.savePowerSchedule.mockClear();
        const before = Date.now();
        chip(name).click();
        fixture.detectChanges();
        confirm().click();
        await fixture.whenStable();
        fixture.detectChanges();
        const [dueAtUtc] = store.savePowerSchedule.mock.calls[0];
        const delta = new Date(dueAtUtc).getTime() - before;
        expect(Math.abs(delta - minutes * 60_000), name).toBeLessThan(2_000);
      }
    });

    it('saves with the local zone and without sending POWER or closing the sheet', async () => {
      store.canSchedulePowerOff.set(true);
      fixture.detectChanges();
      chip('30 min').click();
      fixture.detectChanges();
      confirm().click();
      await fixture.whenStable();
      expect(store.savePowerSchedule).toHaveBeenCalledOnce();
      const [dueAtUtc, zone] = store.savePowerSchedule.mock.calls[0];
      expect(new Date(dueAtUtc).getTime()).toBeGreaterThan(Date.now());
      expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(closed).not.toHaveBeenCalled();
      expect(store.powerOff).not.toHaveBeenCalled();
    });

    it('Personalizar reveals the time of the day and proposes it', () => {
      store.canSchedulePowerOff.set(true);
      fixture.detectChanges();
      chip('Personalizar').click();
      fixture.detectChanges();
      expect(chip('Personalizar').getAttribute('aria-pressed')).toBe('true');
      const input = row().querySelector<HTMLInputElement>('input[type="time"]')!;
      expect(input.value).toBe('22:00');
      expect(confirm()).not.toBeNull();
      input.value = '23:15';
      input.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(confirm().textContent).toContain('23:15');
    });

    it('with a schedule shows "Desliga às HH:MM" and the time left, and cancels it without sending POWER', async () => {
      store.powerSchedule.set({
        id: 'schedule',
        dueAtUtc: new Date(Date.now() + 65 * 60_000).toISOString(),
        timeZone: 'America/Sao_Paulo',
        status: 'pending',
        result: null,
        reason: null,
        version: 2,
      });
      fixture.detectChanges();
      const active = row().querySelector('.schedule-active')!;
      expect(active.textContent).toMatch(/Desliga às \d{2}:\d{2}/);
      expect(active.querySelector('.left')?.textContent).toMatch(/^em 1 h [56] min$/);
      named('Cancelar Agendamento').click();
      await fixture.whenStable();
      expect(store.cancelPowerSchedule).toHaveBeenCalledOnce();
      expect(store.powerOff).not.toHaveBeenCalled();
    });

    it('says the time left in minutes, in whole hours, and nothing once it has passed', () => {
      const due = (minutes: number) => ({
        id: 'schedule',
        dueAtUtc: new Date(Date.now() + minutes * 60_000 - 1_000).toISOString(),
        timeZone: 'America/Sao_Paulo',
        status: 'pending' as const,
        result: null,
        reason: null,
        version: 2,
      });
      store.powerSchedule.set(due(25));
      fixture.detectChanges();
      expect(row().querySelector('.left')?.textContent).toBe('em 25 min');
      store.powerSchedule.set(due(120));
      fixture.detectChanges();
      expect(row().querySelector('.left')?.textContent).toBe('em 2 h');
      store.powerSchedule.set({ ...due(0), dueAtUtc: new Date(Date.now() - 60_000).toISOString() });
      fixture.detectChanges();
      expect(row().querySelector('.left')).toBeNull();
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

    it('sits between the main action and Cancelar, so the main action stays the first thing the eye reaches', () => {
      const now = root.querySelector('.now')!;
      const close = root.querySelector('.close')!;
      expect(now.compareDocumentPosition(row()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(row().compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
