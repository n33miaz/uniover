import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvStatus, TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { StatusIndicator } from './status-indicator';

describe('StatusIndicator', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<StatusIndicator>>;
  let root: HTMLElement;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    // Deixa as promessas encadeadas da ação (ler o estado e depois acordar) terminarem.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };
  const trigger = () => root.querySelector<HTMLButtonElement>('.trigger')!;
  const panel = () => root.querySelector<HTMLElement>('.panel');
  const phase = () => trigger().getAttribute('data-phase');
  const setStatus = async (status: TvStatus, known: TvStatus | null = status) => {
    store.status.set(status);
    store.lastKnownStatus.set(known);
    await render();
  };

  beforeEach(async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(StatusIndicator);
    root = fixture.nativeElement;
    await render();
  });

  it('is a button with a name that says the state, and no panel until it is touched', () => {
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().getAttribute('aria-label')).toBe('Estado do controle: Conectada');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    expect(panel()).toBeNull();
  });

  describe('phase of the dot, one per state', () => {
    it.each<[TvStatus, string, string]>([
      ['hot', 'connected', 'Conectada'],
      ['hibernating', 'sleeping', 'Dormindo'],
      ['loading', 'connecting', 'Reconectando…'],
      ['unresponsive', 'no-reply', 'Sem Resposta'],
      ['pc-off', 'pc-off', 'PC Desligado'],
      ['agent-off', 'agent-off', 'Agente desligado'],
      ['offline', 'offline', 'Sem rede'],
      ['unconfigured', 'attention', 'Sem agente configurado'],
    ])('%s -> %s ("%s")', async (status, expectedPhase, title) => {
      await setStatus(status);
      expect(phase()).toBe(expectedPhase);
      expect(trigger().getAttribute('aria-label')).toBe(`Estado do controle: ${title}`);
      expect(root.querySelector('app-status-dot [data-phase]')?.getAttribute('data-phase')).toBe(
        expectedPhase,
      );
    });

    it('a failed repair by the watchdog while it looks connected is attention', async () => {
      store.watchdog.set({
        kind: 'repair_failed',
        severity: 'error',
        detail: '',
        attempts: 3,
        at: '2026-10-19T14:02:00Z',
      });
      await render();
      expect(phase()).toBe('attention');
      expect(trigger().getAttribute('aria-label')).toBe('Estado do controle: Atenção');
    });
  });

  describe('the little panel', () => {
    const toggle = async () => {
      trigger().click();
      await render();
    };

    it('opens on touch with the name, the meaning and the last update time', async () => {
      await toggle();
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      expect(panel()?.getAttribute('role')).toBe('dialog');
      expect(panel()?.querySelector('strong')?.textContent).toBe('Conectada');
      expect(panel()?.textContent).toContain('Depois de 5 min sem uso');
      expect(panel()?.querySelector('.time')?.textContent).toBe('Atualizado às 14:02');
      expect(panel()?.getAttribute('aria-labelledby')).toBe(panel()?.querySelector('strong')?.id);
      expect(panel()?.querySelector('button')).toBeNull();
    });

    it('lists the known remote service problems only when the repair failed', async () => {
      await toggle();
      expect(panel()?.querySelector('.hints')).toBeNull();
      trigger().click();
      store.watchdog.set({
        kind: 'repair_failed',
        severity: 'error',
        detail: '',
        attempts: 3,
        at: '2026-10-19T14:02:00Z',
      });
      await render();
      await toggle();
      const titles = [...(panel()?.querySelectorAll('.hints li strong') ?? [])].map(
        (item) => item.textContent,
      );
      expect(titles).toEqual(['Serviço Desatualizado', 'Serviços Parados', 'Caixa de TV']);
    });

    it('does not show a time when none was seen', async () => {
      store.seenAtText.set('');
      await toggle();
      expect(panel()?.querySelector('.time')).toBeNull();
    });

    describe('when the dot is near the edge of the screen', () => {
      /** A tela tem 390 px; o jsdom não mede, então o painel "mede" o que o teste disser. */
      const measure = (left: number, width = 320) => {
        Object.defineProperty(document.documentElement, 'clientWidth', {
          value: 390,
          configurable: true,
        });
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
          this: HTMLElement,
        ) {
          const own = this.classList.contains('panel');
          return {
            left: own ? left : 0,
            right: own ? left + width : 0,
            width: own ? width : 0,
            top: 0,
            bottom: 0,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          };
        });
      };
      afterEach(() => {
        vi.restoreAllMocks();
        Reflect.deleteProperty(document.documentElement, 'clientWidth');
      });

      it('slides in from the right edge, keeping a margin', async () => {
        measure(75); // termina em 395, depois dos 390 da tela
        await toggle();
        expect(panel()?.style.getPropertyValue('--shift')).toBe('-17px'); // 390 - 12 - 395
      });

      it('slides in from the left edge too', async () => {
        measure(-20);
        await toggle();
        expect(panel()?.style.getPropertyValue('--shift')).toBe('32px'); // 12 - (-20)
      });

      it('does not move when it already fits', async () => {
        measure(35);
        await toggle();
        expect(panel()?.style.getPropertyValue('--shift')).toBe('0px');
      });

      it('does nothing when nothing can be measured', async () => {
        await toggle();
        expect(panel()?.style.getPropertyValue('--shift')).toBe('');
      });
    });

    it('touching the dot again closes it', async () => {
      await toggle();
      await toggle();
      expect(panel()).toBeNull();
    });

    it('Esc closes it and gives the focus back to the dot', async () => {
      await toggle();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await render();
      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(trigger());
    });

    it('a touch outside closes it, a touch inside does not', async () => {
      await toggle();
      panel()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await render();
      expect(panel()).not.toBeNull();
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await render();
      expect(panel()).toBeNull();
    });

    it('sleeping offers "Acordar o controle", which wakes it and closes the panel', async () => {
      await setStatus('hibernating');
      await toggle();
      expect(panel()?.querySelector('strong')?.textContent).toBe('Dormindo');
      const action = panel()!.querySelector<HTMLButtonElement>('.action')!;
      expect(action.textContent?.trim()).toBe('Acordar o controle');
      action.click();
      await render();
      expect(store.wake).toHaveBeenCalledTimes(1);
      expect(store.refresh).not.toHaveBeenCalled();
      expect(panel()).toBeNull();
      expect(document.activeElement).toBe(trigger());
    });

    describe('by permission', () => {
      const grant = (...permissions: string[]) =>
        TestBed.inject(SessionState).setUser({
          id: '1',
          email: 'a@b.c',
          displayName: 'A',
          role: 'guest',
          permissions,
        });
      afterEach(() => localStorage.clear());

      it('without tv:control "Acordar o controle" is not offered (it is a command), only the explanation', async () => {
        grant('module:tv');
        await setStatus('hibernating');
        await toggle();
        expect(panel()?.querySelector('strong')?.textContent).toBe('Dormindo');
        expect(panel()?.querySelector('.action')).toBeNull();
        expect(store.wake).not.toHaveBeenCalled();
      });

      it('without tv:control the explanation does not tell to tap or wake: it only says the state', async () => {
        grant('module:tv');
        await setStatus('hibernating');
        await toggle();
        expect(panel()?.textContent).toContain(
          'Só o controle está dormindo para poupar a TV; ela continua como estava.',
        );
        expect(panel()?.textContent).not.toContain('toque');
        expect(panel()?.textContent).not.toContain('acorda');

        await setStatus('hot');
        expect(panel()?.textContent).toContain('Depois de 5 min sem uso ele dorme sozinho.');
        expect(panel()?.textContent).not.toContain('toque');
      });

      it('with tv:control the explanation keeps the tap that wakes it', async () => {
        grant('module:tv', 'tv:control');
        await setStatus('hibernating');
        await toggle();
        expect(panel()?.textContent).toContain('O primeiro toque acorda.');
      });

      it('"Tentar de Novo" stays for who only views: reading the state is allowed', async () => {
        grant('module:tv');
        await setStatus('agent-off');
        await toggle();
        const action = panel()!.querySelector<HTMLButtonElement>('.action')!;
        expect(action.textContent?.trim()).toBe('Tentar de Novo');
        action.click();
        await render();
        expect(store.refresh).toHaveBeenCalledTimes(1);
      });

      it('with tv:control the wake action is there', async () => {
        grant('module:tv', 'tv:control');
        await setStatus('hibernating');
        await toggle();
        expect(panel()?.querySelector('.action')?.textContent?.trim()).toBe('Acordar o controle');
      });
    });

    it('without the agent it offers "Tentar de Novo", which reads the state again and then tries to wake', async () => {
      await setStatus('agent-off');
      await toggle();
      const action = panel()!.querySelector<HTMLButtonElement>('.action')!;
      expect(action.textContent?.trim()).toBe('Tentar de Novo');
      action.click();
      await render();
      expect(store.refresh).toHaveBeenCalledTimes(1);
      expect(store.wake).toHaveBeenCalledTimes(1);
      expect(panel()).toBeNull();
    });

    it('while it is not sure yet the dot is green and says so, with nothing to retry', async () => {
      await setStatus('loading');
      await toggle();
      expect(phase()).toBe('connecting');
      expect(panel()?.querySelector('.title strong')?.textContent).toBe('Reconectando…');
      expect(panel()?.textContent).toContain('Os botões já funcionam');
      expect(panel()?.querySelector('.action')).toBeNull();
    });

    it('with the PC off the dot is the sleeping-monitor icon and the panel names since when', async () => {
      store.agentOffText.set('PC Desligado desde 28/10 19:24');
      await setStatus('pc-off');
      expect(root.querySelector('.trigger app-status-dot app-pc-off-icon')).not.toBeNull();
      expect(root.querySelector('.trigger app-status-dot svg.dot')).toBeNull();
      await toggle();
      expect(panel()?.querySelector('.title strong')?.textContent).toBe(
        'PC Desligado desde 28/10 19:24',
      );
      expect(panel()?.querySelector('.action')?.textContent?.trim()).toBe('Tentar de Novo');
    });

    it('only the PC-off state changes the shape of the dot: the others stay plain dots', async () => {
      for (const status of ['hot', 'loading', 'unresponsive', 'agent-off', 'offline'] as const) {
        await setStatus(status);
        expect(root.querySelector('.trigger app-pc-off-icon'), status).toBeNull();
        expect(root.querySelector('.trigger app-status-dot svg.dot'), status).not.toBeNull();
      }
    });

    it('a read with no answer is "Sem Resposta" and offers to try again', async () => {
      await setStatus('unresponsive');
      await toggle();
      expect(panel()?.querySelector('.title strong')?.textContent).toBe('Sem Resposta');
      expect(panel()?.querySelector('.action')?.textContent?.trim()).toBe('Tentar de Novo');
    });

    it('blocks the action while it works, so a double touch asks once', async () => {
      let release!: () => void;
      store.wake.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
      await setStatus('hibernating');
      await toggle();
      const action = panel()!.querySelector<HTMLButtonElement>('.action')!;
      action.click();
      fixture.detectChanges();
      expect(action.disabled).toBe(true);
      action.click();
      release();
      await render();
      expect(store.wake).toHaveBeenCalledTimes(1);
    });

    it('has no action where nothing can be done from here', async () => {
      await setStatus('offline');
      await toggle();
      expect(panel()?.querySelector('.action')).toBeNull();
      expect(panel()?.textContent).toContain('sem internet');
    });

    it('offline shows when the last state was seen and what it was', async () => {
      store.seenAtText.set('13:07');
      await setStatus('offline', 'hibernating');
      await toggle();
      expect(panel()?.querySelector('.time')?.textContent).toBe(
        'Visto às 13:07 · controle dormindo',
      );
    });

    it('gathers the watchdog note and the reconnecting notice that used to be chips', async () => {
      store.watchdogNote.set('controle religado às 14:02');
      store.streamStatus.set('reconnecting');
      await toggle();
      const notes = [...panel()!.querySelectorAll('.note:not(.time)')].map((el) =>
        el.textContent?.trim(),
      );
      expect(notes).toEqual(['controle religado às 14:02', 'Reconectando ao servidor…']);
    });

    it('does not say "reconectando" when the whole network is down', async () => {
      store.streamStatus.set('reconnecting');
      store.link.set('offline');
      await setStatus('offline');
      await toggle();
      expect(panel()?.textContent).not.toContain('Reconectando');
    });
  });

  it('never says the TV is switched off, in any state', async () => {
    for (const status of [
      'hot',
      'hibernating',
      'loading',
      'unresponsive',
      'pc-off',
      'agent-off',
      'offline',
      'unconfigured',
    ] as const) {
      await setStatus(status);
      trigger().click();
      await render();
      expect(root.textContent, status).not.toMatch(/tv desligada/i);
      trigger().click();
      await render();
    }
  });
});
