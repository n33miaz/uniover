import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CHART_ENGINE } from './chart-engine';
import { FakeChartEngine } from './chart-test-kit';
import type { ChartSpec } from './chart-types';
import { ProgressLineChart } from './line-chart';

function spec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    xs: [10, 20, 30],
    ys: [40, 45, 50],
    xRange: [5, 35],
    yRange: [35, 55],
    xTicks: [5, 15, 25, 35],
    yTicks: [35, 45, 55],
    goal: null,
    selected: 2,
    formatX: (seconds) => `d${seconds}`,
    formatY: (value) => String(value),
    ...overrides,
  };
}

/** Observador de tamanho falso: o teste dispara a medida quando quiser. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(): void {
    // O teste dispara a medida: não há o que observar.
  }

  unobserve(): void {
    // idem
  }
  disconnect(): void {
    this.disconnected = true;
  }

  measure(width: number): void {
    this.callback(
      [{ contentRect: { width } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

describe('ProgressLineChart', () => {
  function setup(initial: ChartSpec = spec()) {
    const engine = new FakeChartEngine();
    TestBed.configureTestingModule({ providers: [{ provide: CHART_ENGINE, useValue: engine }] });
    const fixture = TestBed.createComponent(ProgressLineChart);
    fixture.componentRef.setInput('spec', initial);
    const el = fixture.nativeElement as HTMLElement;
    return { engine, fixture, el };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
  });

  it('creates the chart once with what the screen sent, and keeps the reserved space until it is ready', async () => {
    const { engine, fixture, el } = setup();
    let open!: () => void;
    engine.gate = new Promise<void>((resolve) => (open = resolve));

    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.created).toBe(0);
    expect(el.querySelector('.plot')?.classList.contains('ui-skeleton')).toBe(true);

    open();
    await vi.waitFor(() => expect(engine.created).toBe(1));
    fixture.detectChanges();

    expect(engine.specs[0].ys).toEqual([40, 45, 50]);
    // Sem medidor de tamanho (o jsdom não tem), vale a largura de partida.
    expect(engine.widths[0]).toBe(300);
    expect(el.querySelector('.plot')?.classList.contains('ui-skeleton')).toBe(false);
    // O desenho é de canvas: fora da árvore de acessibilidade (quem fala é a tela, com o resumo e a tabela).
    expect(el.querySelector('.plot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('sends every new specification to the drawing, without creating another one', async () => {
    const { engine, fixture } = setup();
    fixture.detectChanges();
    await vi.waitFor(() => expect(engine.created).toBe(1));

    fixture.componentRef.setInput('spec', spec({ ys: [41, 46, 51], selected: 0 }));
    fixture.detectChanges();

    await vi.waitFor(() => expect(engine.last.ys).toEqual([41, 46, 51]));
    expect(engine.last.selected).toBe(0);
    expect(engine.created).toBe(1);
  });

  it('tells the screen which point was tapped', async () => {
    const { engine, fixture } = setup();
    const picked: number[] = [];
    fixture.componentInstance.picked.subscribe((index) => picked.push(index));
    fixture.detectChanges();
    await vi.waitFor(() => expect(engine.created).toBe(1));

    engine.events!.onPick(1);

    expect(picked).toEqual([1]);
  });

  it('tells the screen when the drawing could not start, instead of leaving an empty box', async () => {
    const { engine, fixture } = setup();
    engine.failWith = new Error('sem canvas');
    let failed = 0;
    fixture.componentInstance.failed.subscribe(() => failed++);

    fixture.detectChanges();

    await vi.waitFor(() => expect(failed).toBe(1));
    expect(engine.created).toBe(0);
  });

  it('follows the width of the card: the first valid measure creates it, the next ones resize it', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { engine, fixture } = setup();
    fixture.detectChanges();
    const [observer] = FakeResizeObserver.instances;

    // Largura zero (cartão escondido): ainda não cria.
    observer.measure(0);
    expect(engine.created).toBe(0);

    observer.measure(326);
    await vi.waitFor(() => expect(engine.created).toBe(1));
    expect(engine.widths).toEqual([326]);

    observer.measure(326);
    observer.measure(411.6);
    expect(engine.widths).toEqual([326, 411]);
  });

  it('releases the drawing and stops watching the size when the screen goes away', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { engine, fixture } = setup();
    fixture.detectChanges();
    FakeResizeObserver.instances[0].measure(300);
    await vi.waitFor(() => expect(engine.created).toBe(1));

    fixture.destroy();

    expect(engine.destroyed).toBe(1);
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  });

  it('drops a drawing that finished loading after the screen was gone', async () => {
    const { engine, fixture } = setup();
    fixture.detectChanges();
    fixture.destroy();

    await vi.waitFor(() => expect(engine.created).toBeLessThanOrEqual(1));
    await vi.waitFor(() => expect(engine.destroyed).toBe(engine.created));
  });
});
