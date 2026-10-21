import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore } from '../tv-test-kit';
import { TvPanel } from './tv-panel';

@Component({
  imports: [TvPanel],
  template: `
    <button #opener id="opener" type="button" i18n>abrir</button>
    @if (open()) {
      <app-tv-panel
        [heading]="'Painel de teste'"
        [placement]="placement()"
        [closable]="closable()"
        [opener]="useOpener() ? opener : null"
        (closed)="onClosed()"
      >
        <input id="inside" type="text" />
      </app-tv-panel>
    }
  `,
})
class Host {
  readonly open = signal(false);
  readonly placement = signal<'top' | 'bottom'>('bottom');
  readonly closable = signal(true);
  readonly useOpener = signal(false);
  closes = 0;

  onClosed(): void {
    this.closes++;
    this.open.set(false);
  }
}

function pointer(type: string, init: PointerEventInit = {}): Event {
  return new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, ...init });
}

describe('TvPanel', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  let host: Host;
  let root: HTMLElement;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const dialog = () => root.querySelector<HTMLDialogElement>('dialog')!;
  const card = () => root.querySelector<HTMLElement>('.card')!;
  const grab = () => root.querySelector<HTMLElement>('.grab')!;

  const open = async (opener = true) => {
    if (opener) root.querySelector<HTMLButtonElement>('#opener')!.focus();
    host.open.set(true);
    await render();
  };

  beforeEach(async () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    root = fixture.nativeElement;
    await render();
  });

  it('opens as a modal dialog named by its heading, with the content inside', async () => {
    await open();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    const title = root.querySelector('h2')!;
    expect(title.textContent).toBe('Painel de teste');
    expect(dialog().getAttribute('aria-labelledby')).toBe(title.id);
    expect(dialog().querySelector('#inside')).not.toBeNull();
  });

  it('clears an old notice when it opens and shows new ones inside itself', async () => {
    await open();
    expect(store.clearNotice).toHaveBeenCalledTimes(1);

    store.notice.set({ kind: 'error', text: 'A TV não respondeu a tempo.' });
    await render();
    expect(root.querySelector('.notice[role="alert"]')?.textContent).toBe(
      'A TV não respondeu a tempo.',
    );
    store.notice.set({ kind: 'info', text: 'Lista de apps atualizada.' });
    await render();
    expect(root.querySelector('.notice[role="alert"]')).toBeNull();
    expect(root.querySelector('.notice[role="status"]')?.textContent).toBe(
      'Lista de apps atualizada.',
    );
  });

  describe('closing', () => {
    beforeEach(async () => {
      await open();
    });

    it('Esc closes it once and stops the browser from closing it a second time', () => {
      const event = new Event('cancel', { cancelable: true });
      dialog().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      dialog().dispatchEvent(new Event('close'));
      expect(host.closes).toBe(1);
    });

    it('a native close without `cancel` (Esc with no interaction in Chromium) also closes it', () => {
      dialog().dispatchEvent(new Event('close'));
      expect(host.closes).toBe(1);
    });

    it('a tap outside the card closes it', () => {
      dialog().dispatchEvent(pointer('pointerdown'));
      dialog().click();
      expect(host.closes).toBe(1);
    });

    it('a tap inside the card does not close it', () => {
      const input = root.querySelector<HTMLElement>('#inside')!;
      input.dispatchEvent(pointer('pointerdown'));
      input.click();
      expect(host.closes).toBe(0);
    });

    it('a press that started inside and ended outside (dragging a text selection) does not close it', () => {
      root.querySelector<HTMLElement>('#inside')!.dispatchEvent(pointer('pointerdown'));
      dialog().click();
      expect(host.closes).toBe(0);
    });

    it('a stray click on the backdrop with no press does not close it', () => {
      dialog().click();
      expect(host.closes).toBe(0);
    });

    it('has a labelled close button that closes it', () => {
      const button = root.querySelector<HTMLButtonElement>('.x')!;
      expect(button.getAttribute('aria-label')).toBe('Fechar');
      button.click();
      expect(host.closes).toBe(1);
    });
  });

  describe('closing with an exit animation', () => {
    const stubMotion = (reduced: boolean) =>
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: vi.fn(() => ({ matches: reduced })),
      });
    const endTransition = (property: string, target: Element = card()) =>
      target.dispatchEvent(
        Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: property }),
      );

    afterEach(() => {
      vi.useRealTimers();
      Reflect.deleteProperty(window, 'matchMedia');
    });

    it('says it closed only when the sheet finishes fading out, and meanwhile leaves and ignores touch', async () => {
      stubMotion(false);
      await open();
      root.querySelector<HTMLButtonElement>('.x')!.click();
      fixture.detectChanges();
      expect(host.closes).toBe(0);
      expect(dialog().classList.contains('leaving')).toBe(true);

      endTransition('transform');
      expect(host.closes).toBe(0);
      endTransition('opacity', root.querySelector('.body')!);
      expect(host.closes).toBe(0);
      endTransition('opacity');
      expect(host.closes).toBe(1);
    });

    it('closes by itself after a short limit when the transition never ends', async () => {
      stubMotion(false);
      await open();
      vi.useFakeTimers();
      root.querySelector<HTMLButtonElement>('.x')!.click();
      vi.advanceTimersByTime(299);
      expect(host.closes).toBe(0);
      vi.advanceTimersByTime(1);
      expect(host.closes).toBe(1);
    });

    it('asks once, whatever mix of Esc, taps outside and the button comes during the exit', async () => {
      stubMotion(false);
      await open();
      vi.useFakeTimers();
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
      root.querySelector<HTMLButtonElement>('.x')!.click();
      dialog().dispatchEvent(pointer('pointerdown'));
      dialog().click();
      endTransition('opacity');
      vi.advanceTimersByTime(1000);
      expect(host.closes).toBe(1);
    });

    it('closes at once, with no waiting, for whoever asked for less motion', async () => {
      stubMotion(true);
      await open();
      root.querySelector<HTMLButtonElement>('.x')!.click();
      expect(host.closes).toBe(1);
    });

    it('closes at once when the browser has already closed the dialog by itself', async () => {
      stubMotion(false);
      await open();
      dialog().dispatchEvent(new Event('close'));
      expect(host.closes).toBe(1);
    });

    it('slides out downwards by a short step when closed without dragging', async () => {
      stubMotion(false);
      await open();
      vi.useFakeTimers();
      root.querySelector<HTMLButtonElement>('.x')!.click();
      fixture.detectChanges();
      expect(card().style.transform).toBe('translateY(24px)');
    });

    it('keeps going down from the dragged position instead of coming back', async () => {
      stubMotion(false);
      await open();
      vi.useFakeTimers();
      grab().dispatchEvent(pointer('pointerdown', { clientY: 100 }));
      grab().dispatchEvent(pointer('pointermove', { clientY: 210 }));
      grab().dispatchEvent(pointer('pointerup'));
      fixture.detectChanges();
      expect(card().style.transform).toBe('translateY(110px)');
      expect(dialog().classList.contains('leaving')).toBe(true);
    });

    it('a top panel slides out upwards', async () => {
      stubMotion(false);
      host.placement.set('top');
      await open();
      vi.useFakeTimers();
      root.querySelector<HTMLButtonElement>('.x')!.click();
      fixture.detectChanges();
      expect(card().style.transform).toBe('translateY(-24px)');
    });
  });

  it('has no close button when the content brings its own', async () => {
    host.closable.set(false);
    await open();
    expect(root.querySelector('.x')).toBeNull();
  });

  describe('dragging the handle', () => {
    const drag = (to: number) => {
      grab().dispatchEvent(pointer('pointerdown', { clientY: 100 }));
      grab().dispatchEvent(pointer('pointermove', { clientY: 100 + to }));
    };

    it('follows the finger downwards and closes past the threshold', async () => {
      await open();
      drag(110);
      fixture.detectChanges();
      expect(card().style.transform).toBe('translateY(110px)');
      grab().dispatchEvent(pointer('pointerup'));
      expect(host.closes).toBe(1);
    });

    it('springs back when released before the threshold', async () => {
      await open();
      drag(30);
      fixture.detectChanges();
      expect(card().style.transform).toBe('translateY(30px)');
      grab().dispatchEvent(pointer('pointerup'));
      fixture.detectChanges();
      expect(host.closes).toBe(0);
      expect(card().style.transform).toBe('');
    });

    it('does not move up on a bottom sheet', async () => {
      await open();
      drag(-80);
      fixture.detectChanges();
      expect(card().style.transform).toBe('');
      grab().dispatchEvent(pointer('pointerup'));
      expect(host.closes).toBe(0);
    });

    it('a panel anchored at the top closes by dragging up, not down', async () => {
      host.placement.set('top');
      await open();
      expect(dialog().getAttribute('data-placement')).toBe('top');
      drag(80);
      fixture.detectChanges();
      expect(card().style.transform).toBe('');
      grab().dispatchEvent(pointer('pointerup'));
      expect(host.closes).toBe(0);

      drag(-90);
      fixture.detectChanges();
      expect(card().style.transform).toBe('translateY(-90px)');
      grab().dispatchEvent(pointer('pointerup'));
      expect(host.closes).toBe(1);
    });

    it('pressing the close button does not start a drag', async () => {
      await open();
      const x = root.querySelector<HTMLElement>('.x')!;
      x.dispatchEvent(pointer('pointerdown', { clientY: 100 }));
      grab().dispatchEvent(pointer('pointermove', { clientY: 300 }));
      fixture.detectChanges();
      expect(card().style.transform).toBe('');
    });
  });

  describe('focus', () => {
    it('gives the focus back to what opened it when it goes away', async () => {
      await open();
      // Move o foco para longe (o navegador o leva para dentro do painel); a volta é que está sob teste.
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      host.open.set(false);
      await render();
      expect(document.activeElement).toBe(root.querySelector('#opener'));
    });

    it('prefers the button it was told opened it: Safari does not focus a button on tap', async () => {
      host.useOpener.set(true);
      // Sem foco em lugar nenhum antes de abrir, como no Safari depois de tocar num botão.
      (document.activeElement as HTMLElement | null)?.blur();
      await open(false);
      (document.activeElement as HTMLElement | null)?.blur();
      host.open.set(false);
      await render();
      expect(document.activeElement).toBe(root.querySelector('#opener'));
    });

    it('does not fail when what opened it is gone', async () => {
      await open();
      root.querySelector('#opener')!.remove();
      host.open.set(false);
      await expect(render()).resolves.toBeUndefined();
    });
  });
});
