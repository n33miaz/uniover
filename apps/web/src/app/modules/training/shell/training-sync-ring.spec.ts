import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrainingSyncRing } from './training-sync-ring';
import { type TrainingSyncState, TrainingSyncIndicator } from './training-sync-indicator';

describe('TrainingSyncRing', () => {
  function render(initial: TrainingSyncState, count = 0) {
    const state = signal<TrainingSyncState>(initial);
    const counter = signal(count);
    const sheetOpen = signal(false);
    TestBed.configureTestingModule({
      providers: [
        { provide: TrainingSyncIndicator, useValue: { state, count: counter, sheetOpen } },
      ],
    });
    const fixture = TestBed.createComponent(TrainingSyncRing);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const ring = () => el.querySelector<HTMLButtonElement>('.ring')!;
    return { fixture, el, ring, state, counter, sheetOpen };
  }

  it.each([
    ['busy', 0, 'Sincronizando. Toque para ver o estado.'],
    ['pending', 1, '1 alteração aguardando envio. Toque para ver o estado.'],
    ['pending', 3, '3 alterações aguardando envio. Toque para ver o estado.'],
    ['offline', 0, 'Sem rede. Toque para ver o estado.'],
    ['failed', 2, 'Erro ao sincronizar. Toque para ver o estado.'],
    ['ok', 0, 'Tudo sincronizado. Toque para ver o estado.'],
  ] as const)('draws the %s state (count %i) with its own label', (state, count, label) => {
    const { ring } = render(state, count);
    expect(ring().getAttribute('data-state')).toBe(state);
    expect(ring().getAttribute('aria-label')).toBe(label);
    expect(ring().getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('writes the number in the pending ring (9+ above nine) and "!" in the failed one, and nothing in the others', () => {
    const { fixture, ring, state, counter } = render('pending', 4);
    expect(ring().querySelector('text')?.textContent?.trim()).toBe('4');
    counter.set(12);
    fixture.detectChanges();
    expect(ring().querySelector('text')?.textContent?.trim()).toBe('9+');
    state.set('failed');
    fixture.detectChanges();
    expect(ring().querySelector('text')?.textContent?.trim()).toBe('!');
    for (const other of ['busy', 'offline', 'ok'] as const) {
      state.set(other);
      fixture.detectChanges();
      expect(ring().querySelector('text'), other).toBeNull();
    }
  });

  it('only opens the state sheet when touched: the ring is never a sync button', () => {
    const { ring, sheetOpen } = render('pending', 1);
    expect(sheetOpen()).toBe(false);
    ring().click();
    expect(sheetOpen()).toBe(true);
  });
});
