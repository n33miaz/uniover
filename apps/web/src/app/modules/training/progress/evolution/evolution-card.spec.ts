import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { GoalRepository } from '../../data/goals/goal-repository';
import type { TrainingDb } from '../../data/training-db';
import { eventually, seedHistory } from '../../shell/screen-test-kit';
import type { FakeChartEngine } from '../charts/chart-test-kit';
import { formatOneRepMax } from '../progress-text';
import { BENCH_HISTORY, setupProgress } from '../progress-test-kit';
import { OTHER_EXERCISE, ProgressEvolution } from './evolution-card';

const tenth = (value: number) => Math.round(value * 10) / 10;

describe('ProgressEvolution', () => {
  /** O histórico é gravado antes de a tela existir: ela lê o banco local assim que nasce. */
  async function open(
    exerciseId = 'supino-reto',
    name = 'Supino reto com barra',
    seed: (db: TrainingDb) => Promise<void> = async () => undefined,
    configure: (engine: FakeChartEngine) => void = () => undefined,
  ) {
    const kit = await setupProgress();
    configure(kit.engine);
    await seed(kit.trainingDb);
    const fixture = TestBed.createComponent(ProgressEvolution);
    fixture.componentRef.setInput('exercise', { id: exerciseId, name });
    fixture.componentRef.setInput('chips', [
      { id: exerciseId, label: name },
      { id: 'agachamento', label: 'Agachamento livre' },
      { id: OTHER_EXERCISE, label: 'Outro exercício' },
    ]);
    const el = fixture.nativeElement as HTMLElement;
    return { ...kit, fixture, el };
  }

  const text = (el: Element | null | undefined) =>
    el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const button = (el: HTMLElement, label: string | RegExp) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((node) =>
      typeof label === 'string' ? text(node) === label : label.test(text(node)),
    )!;
  const pressed = (el: HTMLElement, label: string) =>
    button(el, label).getAttribute('aria-pressed');

  describe('with six weeks of bench press', () => {
    const openBench = () =>
      open('supino-reto', 'Supino reto com barra', (db) =>
        seedHistory(db, 'supino-reto', BENCH_HISTORY),
      );

    it('opens on the estimated 1RM of the last 8 weeks, with the last point highlighted', async () => {
      const { fixture, el, engine } = await openBench();
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));

      expect(pressed(el, '1RM estimado')).toBe('true');
      expect(pressed(el, 'Carga máxima')).toBe('false');
      expect(pressed(el, '8 semanas')).toBe('true');
      expect(text(el.querySelector('.when'))).toBe('22/09 · maior carga 42,5 kg × 8');
      // 53,83 − 43,33 = 10,5: o "+10,5 kg desde 18/08" do desenho aprovado.
      expect(text(el.querySelector('.delta'))).toBe('+10,5 kg desde 18/08');

      await vi.waitFor(() => expect(engine.created).toBe(1));
      expect(engine.last.xs).toHaveLength(6);
      expect(engine.last.ys.map(tenth)).toEqual([43.3, 46.7, 50, 50.7, 53.3, 53.8]);
      expect(engine.last.selected).toBe(5);
      expect(engine.last.goal).toBeNull();
    });

    it('gives the chart a spoken summary, since a canvas has no text', async () => {
      const { fixture, el } = await openBench();
      await eventually(fixture, () =>
        expect(el.querySelector('figure[role="img"]')).not.toBeNull(),
      );
      expect(el.querySelector('figure')?.getAttribute('aria-label')).toBe(
        'Gráfico de linha: 1RM estimado de Supino reto com barra nas últimas 8 semanas. ' +
          '6 pontos, de 43,3 kg em 18/08 a 53,8 kg em 22/09.',
      );
    });

    it('walks from point to point with the arrows, and a tap on the chart picks the nearest point', async () => {
      const { fixture, el, engine } = await openBench();
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));
      await vi.waitFor(() => expect(engine.created).toBe(1));

      const next = el.querySelector<HTMLButtonElement>('button[aria-label="Próximo ponto"]')!;
      const previous = el.querySelector<HTMLButtonElement>('button[aria-label="Ponto anterior"]')!;
      expect(next.disabled).toBe(true);

      previous.click();
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,3 kg'));
      expect(text(el.querySelector('.when'))).toContain('15/09');
      expect(engine.last.selected).toBe(4);
      expect(next.disabled).toBe(false);

      engine.events!.onPick(0);
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('43,3 kg'));
      expect(previous.disabled).toBe(true);
      expect(engine.last.selected).toBe(0);
    });

    it('switches to the top weight: other numbers, no goal button, another note', async () => {
      const { fixture, el, engine } = await openBench();
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));
      expect(text(el)).toContain('Epley, só séries de 1 a 10 repetições');
      expect(button(el, /Definir meta/)).toBeDefined();

      button(el, 'Carga máxima').click();
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('42,5 kg'));
      expect(text(el.querySelector('.when'))).toBe('22/09 · 8 repetições');
      expect(engine.last.ys).toEqual([32.5, 35, 37.5, 40, 40, 42.5]);
      expect(text(el.querySelector('.delta'))).toBe('+10 kg desde 18/08');
      expect(text(el)).toContain('Maior carga de cada dia');
      expect(text(el)).not.toContain('Epley');
      expect(button(el, /meta/i)).toBeUndefined();
    });

    it('shows a table with the same points as the chart, newest first, behind a "Ver dados" button', async () => {
      const { fixture, el, engine } = await openBench();
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));
      expect(el.querySelector('table')).toBeNull();

      const toggle = button(el, 'Ver dados');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.click();
      fixture.detectChanges();

      expect(button(el, 'Ocultar dados').getAttribute('aria-expanded')).toBe('true');
      const rows = Array.from(el.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.children).map((cell) => text(cell)),
      );
      expect(rows).toHaveLength(6);
      expect(rows[0]).toEqual(['22/09', '53,8 kg', '42,5 kg × 8']);
      expect(rows[5]).toEqual(['18/08', '43,3 kg', '32,5 kg × 10']);
      // O que a tabela mostra é o que o gráfico desenha, na ordem contrária.
      const drawn = engine.last.ys.map((value) => formatOneRepMax(value)).reverse();
      expect(rows.map((row) => row[1])).toEqual(drawn);
      expect(text(el.querySelector('caption'))).toBe(
        'Dados do gráfico: 1RM estimado de Supino reto com barra',
      );
      expect(Array.from(el.querySelectorAll('thead th')).map((cell) => text(cell))).toEqual([
        'Dia',
        '1RM estimado',
        'Maior carga do dia',
      ]);
    });

    it('draws the goal line, with a label, and lets the owner define, change and remove it', async () => {
      const { fixture, el, engine } = await openBench();
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));
      await vi.waitFor(() => expect(engine.created).toBe(1));

      const goals = TestBed.inject(GoalRepository);
      await goals.set('exercise_e1rm', 55, 'supino-reto');
      await eventually(fixture, () =>
        expect(engine.last.goal).toEqual({ value: 55, label: 'meta 55 kg' }),
      );
      expect(text(button(el, /^Meta:/))).toBe('Meta: 55 kg');
      expect(button(el, /^Meta:/).getAttribute('aria-label')).toBe('Meta: 55 kg. Editar a meta');

      // A meta de outro exercício não aparece neste.
      await goals.set('exercise_e1rm', 90, 'agachamento');
      fixture.detectChanges();
      expect(engine.last.goal?.value).toBe(55);

      await goals.clear('exercise_e1rm', 'supino-reto');
      await eventually(fixture, () => expect(engine.last.goal).toBeNull());
      expect(text(button(el, /meta/i))).toBe('Definir meta');
    });

    it('saves a goal typed in the sheet once, in the local database and in the send queue', async () => {
      const { fixture, el, engine, trainingDb, db } = await openBench();
      await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));

      button(el, 'Definir meta').click();
      fixture.detectChanges();
      const input = el.querySelector<HTMLInputElement>('app-goal-sheet input')!;
      expect(input).not.toBeNull();
      input.value = '55,5';
      input.dispatchEvent(new Event('input'));
      el.querySelector<HTMLButtonElement>('app-goal-sheet button.primary')!.click();

      await vi.waitFor(async () => {
        expect(await trainingDb.goals.get('exercise_e1rm:supino-reto')).toMatchObject({
          value: 55.5,
        });
      });
      await eventually(fixture, () => expect(engine.last.goal?.value).toBe(55.5));
      const queued = await db.outbox.toArray();
      expect(queued).toHaveLength(1);
      expect(queued[0].url).toMatch(/\/goals\/exercise_e1rm$/);
    });
  });

  it('says it needs more than one training to draw a line when there is a single point', async () => {
    const { fixture, el, engine } = await open('agachamento', 'Agachamento livre', (db) =>
      seedHistory(db, 'agachamento', [[100, 60, 8]]),
    );
    await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('76 kg'));

    expect(text(el.querySelector('.hint'))).toContain('Só um treino neste período');
    expect(el.querySelector('.delta')).toBeNull();
    await vi.waitFor(() => expect(engine.created).toBe(1));
    expect(engine.last.xs).toHaveLength(1);
    expect(el.querySelector('figure')?.getAttribute('aria-label')).toContain('Um ponto: 76 kg em');
  });

  it('explains an exercise with no record at all, with a way to Hoje, and draws nothing', async () => {
    const { fixture, el, engine } = await open('elevacao', 'Elevação lateral');
    await eventually(fixture, () =>
      expect(text(el)).toContain('Sem registro deste exercício ainda'),
    );
    expect(el.querySelector('a[href="/treino"]')).not.toBeNull();
    expect(el.querySelector('figure')).toBeNull();
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('[aria-label="Período do gráfico"]')).toBeNull();
    expect(engine.created).toBe(0);
  });

  it('offers "Ver tudo" when the exercise was trained, but not in the chosen period', async () => {
    // Dias 5 e 20: bem antes das 8 semanas (dias 59 a 115).
    const { fixture, el, engine } = await open('supino-inclinado', 'Supino inclinado', (db) =>
      seedHistory(db, 'supino-inclinado', [
        [5, 20, 10],
        [20, 22.5, 10],
      ]),
    );
    await eventually(fixture, () =>
      expect(text(el)).toContain('Nenhum treino deste exercício neste período.'),
    );
    expect(el.querySelector('figure')).toBeNull();

    button(el, 'Ver tudo').click();
    await eventually(fixture, () => expect(el.querySelector('figure')).not.toBeNull());
    expect(pressed(el, 'Tudo')).toBe('true');
    await vi.waitFor(() => expect(engine.last.xs).toHaveLength(2));
  });

  it('keeps the 6 months and "Tudo" periods apart, by the date of each training', async () => {
    // Dia 30: 85 dias antes de "agora", dentro dos 6 meses e fora das 8 semanas.
    const { fixture, el, engine } = await open('supino-reto', 'Supino reto com barra', (db) =>
      seedHistory(db, 'supino-reto', [[30, 30, 10], ...BENCH_HISTORY]),
    );
    await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));
    await vi.waitFor(() => expect(engine.last.xs).toHaveLength(6));

    button(el, '6 meses').click();
    await vi.waitFor(() => expect(engine.last.xs).toHaveLength(7));
    expect(pressed(el, '6 meses')).toBe('true');
    // Com um ponto a mais, a variação passa a contar do primeiro dia do período.
    await eventually(fixture, () =>
      expect(text(el.querySelector('.delta'))).toBe('+13,8 kg desde 15/07'),
    );
  });

  it('says the 1RM cannot be estimated when every set has more than 10 repetitions, and offers the load', async () => {
    const { fixture, el } = await open('supino-inclinado', 'Supino inclinado', (db) =>
      seedHistory(db, 'supino-inclinado', [
        [100, 20, 15],
        [107, 22.5, 15],
      ]),
    );
    await eventually(fixture, () => expect(text(el)).toContain('o 1RM não pode ser estimado'));
    expect(el.querySelector('figure')).toBeNull();

    button(el, 'Ver a carga máxima').click();
    await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('22,5 kg'));
    expect(pressed(el, 'Carga máxima')).toBe('true');
  });

  it('falls back to the table, with a notice, when the chart library cannot be loaded', async () => {
    const { fixture, el } = await open(
      'supino-reto',
      'Supino reto com barra',
      (db) => seedHistory(db, 'supino-reto', BENCH_HISTORY),
      (engine) => (engine.failWith = new Error('sem canvas')),
    );

    await eventually(fixture, () =>
      expect(text(el)).toContain('Não foi possível carregar o gráfico agora'),
    );
    expect(el.querySelector('figure')).toBeNull();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(6);
    // O valor e as setas continuam: o resto da tela não depende do desenho.
    expect(text(el.querySelector('.value'))).toBe('53,8 kg');
  });

  it('tells the page which exercise was tapped, and when "Outro exercício" was', async () => {
    const { fixture, el } = await open();
    const chosen: string[] = [];
    let others = 0;
    fixture.componentInstance.exerciseChange.subscribe((id) => chosen.push(id));
    fixture.componentInstance.pickOther.subscribe(() => others++);
    fixture.detectChanges();

    button(el, 'Agachamento livre').click();
    // O chip do exercício que já está aberto não avisa nada.
    button(el, 'Supino reto com barra').click();
    button(el, 'Outro exercício').click();

    expect(chosen).toEqual(['agachamento']);
    expect(others).toBe(1);
    expect(pressed(el, 'Supino reto com barra')).toBe('true');
  });
});
