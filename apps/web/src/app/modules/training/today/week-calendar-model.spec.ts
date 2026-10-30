import { weekRange } from '../domain/progress/calendar';
import { sundayMonth, sundayWeek, moveMonth } from './week-calendar-model';

describe('training calendar', () => {
  it('shows Sunday through Saturday with numeric dates across a month boundary', () => {
    const week = sundayWeek(Date.UTC(2026, 9, 22, 12), 0, 'America/Sao_Paulo');
    expect(week.days.map((day) => day.key)).toEqual([
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(sundayWeek(Date.UTC(2026, 9, 22, 12), -3, 'America/Sao_Paulo').days[0].key).toBe(
      '2026-09-27',
    );
    // Uma semana que cruza o mês leva os dois meses.
    const crossing = sundayWeek(Date.UTC(2026, 9, 1, 12), 0, 'America/Sao_Paulo');
    expect(crossing.days[0].key).toBe('2026-09-27');
    expect(crossing.days[6].key).toBe('2026-10-03');
  });

  it('keeps a local Sunday during a daylight saving change', () => {
    // 8 de março de 2026 é o domingo em que Nova York adianta o relógio: a semana nasce com um dia de 23 horas.
    const week = sundayWeek(Date.UTC(2026, 2, 8, 12), 0, 'America/New_York');
    expect(week.days[0].key).toBe('2026-03-08');
    expect(week.days[6].key).toBe('2026-03-14');
    expect(week.end - week.start).toBe(167 * 60 * 60 * 1000);
    // O fim do horário de verão (1º de novembro) dá uma semana de 169 horas.
    const fall = sundayWeek(Date.UTC(2026, 10, 3, 12), 0, 'America/New_York');
    expect(fall.days[0].key).toBe('2026-11-01');
    expect(fall.end - fall.start).toBe(169 * 60 * 60 * 1000);
  });

  it('turns the week at local midnight between Saturday and Sunday', () => {
    const zone = 'America/Sao_Paulo';
    // Sábado 23:30 em São Paulo já é domingo em UTC: ainda é a semana que termina nesse sábado.
    const saturday = sundayWeek(Date.UTC(2026, 9, 25, 2, 30), 0, zone);
    expect(saturday.days[0].key).toBe('2026-10-18');
    expect(saturday.days[6].key).toBe('2026-10-24');
    // Domingo 00:10 em São Paulo abre a semana seguinte.
    const sunday = sundayWeek(Date.UTC(2026, 9, 25, 3, 10), 0, zone);
    expect(sunday.days[0].key).toBe('2026-10-25');
    expect(sunday.start).toBe(saturday.end);
    expect(sundayWeek(Date.UTC(2026, 11, 31, 20), 0, zone).days[0].key).toBe('2026-12-27');
  });

  it('is the same week as the progress screen, so the totals agree', () => {
    const zone = 'America/Sao_Paulo';
    const instants = [
      // Sábado 23:30 em São Paulo já é domingo em UTC: ainda é a semana que termina nesse sábado.
      Date.UTC(2026, 9, 25, 2, 30),
      // Domingo 00:10 em São Paulo.
      Date.UTC(2026, 9, 25, 3, 10),
      Date.UTC(2026, 9, 22, 12),
      Date.UTC(2026, 9, 24, 12),
      Date.UTC(2026, 11, 31, 20),
      Date.UTC(2026, 2, 8, 12),
    ];
    for (const instant of instants) {
      for (const offset of [0, -1, 2]) {
        const progress = weekRange(instant, zone);
        const today = sundayWeek(instant, 0, zone);
        expect(today.start).toBe(progress.start);
        expect(today.end).toBe(progress.end);
        expect(today.days[0].key).toBe(progress.startKey);
        expect(today.days[6].key).toBe(progress.endKey);
        const moved = sundayWeek(instant, offset, zone);
        expect(moved.days[0].key).toBe(
          weekRange(progress.start + offset * 7 * 86_400_000 + 12 * 3_600_000, zone).startKey,
        );
      }
    }
  });

  it('pads the monthly calendar from Sunday and moves through years', () => {
    // 1º de outubro de 2026 é uma quinta: quatro vazios antes dele (dom, seg, ter, qua).
    const cells = sundayMonth({ year: 2026, month: 10 });
    expect(cells).toHaveLength(35);
    expect(cells.slice(0, 4)).toEqual([null, null, null, null]);
    expect(cells[4]?.day).toBe(1);
    expect(cells[34]?.day).toBe(31);
    // Um mês que começa num domingo não tem vazio antes; um que começa no sábado tem seis.
    expect(sundayMonth({ year: 2026, month: 11 })[0]?.day).toBe(1);
    expect(sundayMonth({ year: 2026, month: 8 }).findIndex((cell) => cell?.day === 1)).toBe(6);
    expect(moveMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });
});
