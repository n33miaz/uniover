import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import type { TrainingSync } from '../data/sync/training-sync';
import { ExercisesSwitch } from './exercises-switch';
import { awaitingFirstPull, settledAfterFirstPull } from './first-pull';
import { formatDayMonth, formatDuration, formatKg } from './format';
import { ChipOption, TrainingChips } from './training-chips';
import { TrainingSheet } from './training-sheet';

describe('format', () => {
  it('writes the load in kilos with a decimal comma, and no decimals for a whole number', () => {
    expect(formatKg(42.5)).toBe('42,5 kg');
    expect(formatKg(40)).toBe('40 kg');
    expect(formatKg(1.25)).toBe('1,25 kg');
  });

  it('writes the day and month of an instant', () => {
    expect(formatDayMonth(new Date(2026, 9, 18, 12).getTime())).toBe('18/10');
  });

  it('writes a duration in minutes and seconds', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(95)).toBe('1 min 35 s');
  });
});

describe('awaitingFirstPull', () => {
  const state = (
    online: boolean,
    error: string | null,
    lastPullAt: number | null,
    settled = false,
    expired = false,
  ) =>
    awaitingFirstPull(
      {
        error: () => error,
        lastPullAt: () => lastPullAt,
        firstPassSettled: () => settled,
        firstPullWaitExpired: () => expired,
      } as unknown as TrainingSync,
      { online: () => online } as unknown as ConnectivityService,
    );

  it('waits only with network, without a failure, and before the first pull ever finished', () => {
    expect(state(true, null, null)).toBe(true);
    expect(state(false, null, null)).toBe(false);
    expect(state(true, 'network', null)).toBe(false);
    expect(state(true, null, 1_760_000_000_000)).toBe(false);
  });

  it('stops waiting once the first pass decided it will not pull, so the skeleton never lasts forever', () => {
    expect(state(true, null, null, true)).toBe(false);
  });

  it('stops waiting once the wait deadline passed with the request still pending', () => {
    expect(state(true, null, null, false, true)).toBe(false);
  });

  describe('with the resources the screen needs', () => {
    const needs = ['routines', 'sessions'];
    const withNeeds = (pulled: readonly string[], overrides: Record<string, unknown> = {}) =>
      awaitingFirstPull(
        {
          error: () => null,
          lastPullAt: () => null,
          firstPassSettled: () => false,
          firstPullWaitExpired: () => false,
          resourcesPulled: (names: readonly string[]) => names.every((n) => pulled.includes(n)),
          ...overrides,
        } as unknown as TrainingSync,
        { online: () => true } as unknown as ConnectivityService,
        needs,
      );

    it('keeps waiting until every needed resource was pulled, however many others were', () => {
      expect(withNeeds([])).toBe(true);
      expect(withNeeds(['routines'])).toBe(true);
      expect(withNeeds(['exercises', 'sets', 'goals'])).toBe(true);
    });

    it('stops waiting as soon as the needed resources were pulled, without the rest of the pass', () => {
      expect(withNeeds(['sessions', 'routines'])).toBe(false);
    });

    it('keeps every other way out: offline, a failure, an earlier pull, the pass settling, the deadline', () => {
      const wait = (overrides: Record<string, unknown>, online = true) =>
        awaitingFirstPull(
          {
            error: () => null,
            lastPullAt: () => null,
            firstPassSettled: () => false,
            firstPullWaitExpired: () => false,
            resourcesPulled: () => false,
            ...overrides,
          } as unknown as TrainingSync,
          { online: () => online } as unknown as ConnectivityService,
          needs,
        );
      expect(wait({})).toBe(true);
      expect(wait({}, false)).toBe(false);
      expect(wait({ error: () => 'server' })).toBe(false);
      expect(wait({ lastPullAt: () => 1 })).toBe(false);
      expect(wait({ firstPassSettled: () => true })).toBe(false);
      expect(wait({ firstPullWaitExpired: () => true })).toBe(false);
    });
  });
});

describe('ExercisesSwitch', () => {
  function render(current: 'catalog' | 'routines') {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(ExercisesSwitch);
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('links the two screens and marks the open one as the current page', () => {
    const el = render('routines');
    const links = Array.from(el.querySelectorAll('a'));
    expect(links.map((link) => [link.textContent?.trim(), link.getAttribute('href')])).toEqual([
      ['Catálogo', '/treino/exercicios'],
      ['Rotinas', '/treino/rotinas'],
    ]);
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page']);
    expect(el.querySelector('nav')?.getAttribute('aria-label')).toBe('Catálogo ou rotinas');
  });
});

@Component({
  imports: [TrainingChips],
  // Anfitrião de teste: os textos abaixo são de teste, não de tela.
  template: `<!-- eslint-disable @angular-eslint/template/i18n -->
    <app-training-chips
      [options]="options"
      [selected]="selected()"
      label="Filtrar por grupo"
      (selectedChange)="selected.set($event)"
    />`,
})
class ChipsHost {
  readonly options: readonly ChipOption[] = [
    { id: '', label: 'Todos' },
    { id: 'chest', label: 'Peito' },
  ];
  readonly selected = signal('');
}

describe('TrainingChips', () => {
  it('shows one button per option with the chosen one pressed, and reports the choice', () => {
    const fixture = TestBed.createComponent(ChipsHost);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
    expect(el.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Filtrar por grupo',
    );
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    buttons[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()).toBe('chest');
    expect(el.querySelectorAll<HTMLButtonElement>('button')[1].getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

@Component({
  imports: [TrainingSheet],
  // Anfitrião de teste: os textos abaixo são de teste, não de tela.
  template: `<!-- eslint-disable @angular-eslint/template/i18n -->
    <app-training-sheet
      heading="Um título"
      dismissLabel="Cancelar"
      (closed)="closed.set(closed() + 1)"
    >
      <p class="content">Miolo</p>
      <button sheetAction type="button" class="extra">Extra</button>
    </app-training-sheet>`,
})
class SheetHost {
  readonly closed = signal(0);
}

describe('TrainingSheet', () => {
  function render() {
    const fixture = TestBed.createComponent(SheetHost);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, dialog: el.querySelector('dialog')! };
  }

  it('opens as a modal dialog named by its title, with the content and the footer actions', async () => {
    const { fixture, el, dialog } = render();
    await fixture.whenStable();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe(el.querySelector('h2')?.id);
    expect(el.querySelector('h2')?.textContent).toBe('Um título');
    expect(el.querySelector('.content')?.textContent).toBe('Miolo');
    expect(
      Array.from(el.querySelectorAll('.footer button')).map((b) => b.textContent?.trim()),
    ).toEqual(['Extra', 'Cancelar']);
  });

  it('goes down and tells the page once, by the footer button', async () => {
    const { fixture, el } = render();
    await fixture.whenStable();
    const dismiss = el.querySelector<HTMLButtonElement>('.footer button.secondary')!;
    dismiss.click();
    dismiss.click();
    expect(fixture.componentInstance.closed()).toBe(1);
  });

  it('closes before telling the page and returns focus to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { fixture, el, dialog } = render();
    await fixture.whenStable();

    el.querySelector<HTMLButtonElement>('.footer button.secondary')!.click();

    expect(dialog.open).toBe(false);
    expect(fixture.componentInstance.closed()).toBe(1);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes on Esc and on a touch on the dimmed background, not on a touch in the content', async () => {
    const first = render();
    await first.fixture.whenStable();
    first.dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(first.fixture.componentInstance.closed()).toBe(1);

    const second = render();
    await second.fixture.whenStable();
    second.el.querySelector<HTMLElement>('.content')!.click();
    // The side margins and the strip around the title belong to the sheet itself, not to the dimmed background.
    second.el.querySelector<HTMLElement>('.inner')!.click();
    second.el.querySelector<HTMLElement>('h2')!.click();
    Object.defineProperty(second.dialog, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: 10, right: 300, bottom: 500 }),
    });
    const pointerDown = (target: Element, x: number, y: number) => {
      target.dispatchEvent(
        Object.assign(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }),
          { isPrimary: true },
        ),
      );
    };
    pointerDown(second.dialog, 20, 20);
    second.dialog.dispatchEvent(new MouseEvent('click', { clientX: 20, clientY: 20 }));
    pointerDown(second.el.querySelector('.content')!, 20, 20);
    second.dialog.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
    pointerDown(second.dialog, 0, 0);
    second.el
      .querySelector('.content')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }));
    expect(second.fixture.componentInstance.closed()).toBe(0);
    pointerDown(second.dialog, 0, 0);
    second.dialog.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
    expect(second.fixture.componentInstance.closed()).toBe(1);
  });
});

describe('settledAfterFirstPull', () => {
  function setup(initiallyPulled: boolean) {
    const pulled = signal(initiallyPulled);
    const sync = {
      error: () => null,
      lastPullAt: () => null,
      firstPassSettled: () => false,
      firstPullWaitExpired: () => false,
      resourcesPulled: () => pulled(),
    } as unknown as TrainingSync;
    const connectivity = { online: () => true } as unknown as ConnectivityService;
    let finish!: () => void;
    const reload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const settled = TestBed.runInInjectionContext(() =>
      settledAfterFirstPull(sync, connectivity, ['routines'], reload),
    );
    return { pulled, reload, settled, finish: () => finish() };
  }

  it('is true at once, with no extra read, for a screen that never had to wait', () => {
    const { settled, reload } = setup(true);
    TestBed.tick();
    expect(settled()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('after a wait, reads once more and only then settles, so a stale read cannot show a false empty state', async () => {
    const { pulled, settled, reload, finish } = setup(false);
    TestBed.tick();
    expect(settled()).toBe(false);

    pulled.set(true);
    TestBed.tick();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled()).toBe(false);

    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled()).toBe(true);
  });

  it('settles even when the extra read fails, so the skeleton never lasts forever', async () => {
    const pulled = signal(false);
    const sync = {
      error: () => null,
      lastPullAt: () => null,
      firstPassSettled: () => false,
      firstPullWaitExpired: () => false,
      resourcesPulled: () => pulled(),
    } as unknown as TrainingSync;
    const settled = TestBed.runInInjectionContext(() =>
      settledAfterFirstPull(
        sync,
        { online: () => true } as unknown as ConnectivityService,
        ['routines'],
        () => Promise.reject(new Error('idb')),
      ),
    );
    TestBed.tick();
    pulled.set(true);
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled()).toBe(true);
  });
});
