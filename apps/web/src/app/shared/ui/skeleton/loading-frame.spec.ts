import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LOADING_RELOAD, LOADING_TIMING, LoadingFrame } from './loading-frame';
import { Skeleton } from './skeleton';

@Component({
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame
      [label]="'Carregando a lista…'"
      [reload]="reload()"
      (retried)="retries.set(retries() + 1)"
    >
      <span appSkeleton class="bone"></span>
    </app-loading-frame>
  `,
})
class Host {
  readonly reload = signal(true);
  readonly retries = signal(0);
}

describe('LoadingFrame', () => {
  const reload = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    reload.mockReset();
    TestBed.configureTestingModule({
      providers: [
        { provide: LOADING_TIMING, useValue: { giveUpAfterMs: 1000 } },
        { provide: LOADING_RELOAD, useValue: reload },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  function render() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('reserves the shape, hides it from screen readers and speaks one label', () => {
    const { el } = render();

    expect(el.querySelector('app-loading-frame')?.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('Carregando a lista…');
    const shape = el.querySelector('.shape') as HTMLElement;
    expect(shape.getAttribute('aria-hidden')).toBe('true');
    // Só se mostra depois do atraso (uma resposta rápida não pisca): a forma já ocupa o lugar, mas pela animação.
    expect(shape.classList.contains('ui-wait')).toBe(true);
    expect(shape.querySelector('.bone.ui-skeleton')).not.toBeNull();
  });

  it('turns into a short notice instead of shimmering forever', () => {
    const { fixture, el } = render();

    vi.advanceTimersByTime(999);
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')).toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(el.querySelector('.shape')).toBeNull();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Está demorando');
    expect(el.querySelector('app-loading-frame')?.getAttribute('aria-busy')).toBeNull();
  });

  it('reloads the page on "Tentar de Novo" when the screen has no read of its own', () => {
    const { fixture, el } = render();
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();

    (el.querySelector('button') as HTMLButtonElement).click();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.retries()).toBe(1);
  });

  it('asks the screen to read again, and restarts the clock, when the screen owns the read', () => {
    const { fixture, el } = render();
    fixture.componentInstance.reload.set(false);
    fixture.detectChanges();
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();

    (el.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(reload).not.toHaveBeenCalled();
    expect(fixture.componentInstance.retries()).toBe(1);
    // De volta à espera, com o relógio recomeçado: o aviso só volta se demorar de novo.
    expect(el.querySelector('.shape')).not.toBeNull();
    vi.advanceTimersByTime(999);
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('stops its clock when the data arrives and the frame leaves', () => {
    const { fixture } = render();
    fixture.destroy();
    // Sem relógio solto depois de sair de cena.
    expect(vi.getTimerCount()).toBe(0);
  });
});
