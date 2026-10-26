import {
  addDays,
  civilDateOf,
  dateKey,
  deviceTimeZone,
  monthRange,
  periodRange,
  startOfDay,
  weekRange,
  weekdayIndex,
} from './calendar';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';
const HOUR = 60 * 60 * 1000;

/** Um instante pelo relógio de Brasília (UTC-3, sem horário de verão desde 2019). */
const sp = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0) =>
  Date.UTC(year, month - 1, day, hour + 3, minute, second, ms);

describe('dateKey', () => {
  it('uses the day of the given time zone, not the machine one', () => {
    expect(dateKey(Date.UTC(2026, 9, 19, 2, 59, 59), SP)).toBe('2026-10-18');
    expect(dateKey(Date.UTC(2026, 9, 19, 3, 0, 0), SP)).toBe('2026-10-19');
    expect(dateKey(Date.UTC(2026, 9, 19, 2, 59, 59), 'UTC')).toBe('2026-10-19');
    expect(dateKey(Date.UTC(2026, 9, 19, 12, 0, 0), 'Pacific/Kiritimati')).toBe('2026-10-20');
  });

  it('keeps the local midnight on the right side', () => {
    expect(dateKey(sp(2026, 10, 18, 23, 59, 59, 999), SP)).toBe('2026-10-18');
    expect(dateKey(sp(2026, 10, 19, 0, 0, 0, 0), SP)).toBe('2026-10-19');
  });

  it('writes the year with four digits and the month and day with two', () => {
    expect(dateKey(sp(2026, 1, 5, 12), SP)).toBe('2026-01-05');
  });
});

describe('weekRange', () => {
  it('runs from Monday to Sunday: 12 to 18 October 2026 (12/10 was a Monday)', () => {
    const week = weekRange(sp(2026, 10, 18, 9, 30), SP);

    expect(week.startKey).toBe('2026-10-12');
    expect(week.endKey).toBe('2026-10-18');
    expect(week.start).toBe(sp(2026, 10, 12));
    expect(week.end).toBe(sp(2026, 10, 19));
  });

  it('has exactly seven days in Sao Paulo, where summer time no longer exists', () => {
    for (const day of [3, 10, 17, 24]) {
      const week = weekRange(sp(2026, 11, day, 12), SP);
      expect(week.end - week.start).toBe(7 * 24 * HOUR);
    }
    const summer = weekRange(sp(2026, 1, 14, 12), SP);
    expect(summer.end - summer.start).toBe(7 * 24 * HOUR);
  });

  it('puts Sunday 23:59:59.999 in the week and Monday 00:00 in the next one (local midnight)', () => {
    const lastMoment = weekRange(sp(2026, 10, 18, 23, 59, 59, 999), SP);
    const nextMoment = weekRange(sp(2026, 10, 19, 0, 0, 0, 0), SP);

    expect(lastMoment.startKey).toBe('2026-10-12');
    expect(nextMoment.startKey).toBe('2026-10-19');
    expect(nextMoment.start).toBe(lastMoment.end);
  });

  it('crosses the month: 31 August to 6 September 2026', () => {
    const week = weekRange(sp(2026, 9, 2, 8), SP);

    expect(week.startKey).toBe('2026-08-31');
    expect(week.endKey).toBe('2026-09-06');
  });

  it('crosses the year: 28 December 2026 to 3 January 2027', () => {
    const week = weekRange(sp(2027, 1, 1, 8), SP);

    expect(week.startKey).toBe('2026-12-28');
    expect(week.endKey).toBe('2027-01-03');
    expect(weekRange(sp(2026, 12, 31, 23, 59), SP).startKey).toBe('2026-12-28');
  });

  it('counts a week with a clock change as 169 hours when the clock goes back (New York, 1 November 2026)', () => {
    const week = weekRange(Date.UTC(2026, 10, 1, 12), NY);

    expect(week.startKey).toBe('2026-10-26');
    expect(week.endKey).toBe('2026-11-01');
    expect(week.end - week.start).toBe(169 * HOUR);
    expect(week.start).toBe(Date.UTC(2026, 9, 26, 4));
    expect(week.end).toBe(Date.UTC(2026, 10, 2, 5));
  });

  it('counts a week with a clock change as 167 hours when the clock goes forward (New York, 8 March 2026)', () => {
    const week = weekRange(Date.UTC(2026, 2, 8, 12), NY);

    expect(week.end - week.start).toBe(167 * HOUR);
  });

  it('gives the same weeks whatever the hour of the day', () => {
    const monday = weekRange(sp(2026, 10, 14), SP);
    for (const hour of [0, 6, 12, 18, 23]) {
      expect(weekRange(sp(2026, 10, 14, hour), SP)).toEqual(monday);
    }
  });
});

describe('startOfDay', () => {
  it('is the local midnight in UTC', () => {
    expect(startOfDay({ year: 2026, month: 10, day: 19 }, SP)).toBe(Date.UTC(2026, 9, 19, 3));
    expect(startOfDay({ year: 2026, month: 10, day: 19 }, 'UTC')).toBe(Date.UTC(2026, 9, 19));
  });

  it('is the first instant of the day when the local midnight did not exist (Sao Paulo, 4 November 2018)', () => {
    const start = startOfDay({ year: 2018, month: 11, day: 4 }, SP);

    expect(new Date(start).toISOString()).toBe('2018-11-04T03:00:00.000Z');
    expect(dateKey(start, SP)).toBe('2018-11-04');
    expect(dateKey(start - 1, SP)).toBe('2018-11-03');
  });
});

describe('calendar arithmetic', () => {
  it('adds days across months and years, and finds the weekday', () => {
    expect(addDays({ year: 2026, month: 12, day: 30 }, 5)).toEqual({
      year: 2027,
      month: 1,
      day: 4,
    });
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
    expect(weekdayIndex({ year: 2026, month: 10, day: 12 })).toBe(0);
    expect(weekdayIndex({ year: 2026, month: 10, day: 18 })).toBe(6);
  });

  it('civilDateOf reads the local day', () => {
    expect(civilDateOf(Date.UTC(2026, 9, 19, 2, 0), SP)).toEqual({
      year: 2026,
      month: 10,
      day: 18,
    });
  });
});

describe('monthRange', () => {
  it('knows the length of the month and its limits in the local time zone', () => {
    const october = monthRange(2026, 10, SP);

    expect(october.daysInMonth).toBe(31);
    expect(october.start).toBe(sp(2026, 10, 1));
    expect(october.end).toBe(sp(2026, 11, 1));
    expect(monthRange(2028, 2, SP).daysInMonth).toBe(29);
    expect(monthRange(2026, 2, SP).daysInMonth).toBe(28);
    expect(monthRange(2026, 12, SP).end).toBe(sp(2027, 1, 1));
  });
});

describe('periodRange', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  /** Um instante pelo relógio de Tóquio (UTC+9, sem horário de verão). */
  const tokyo = (year: number, month: number, day: number, hour = 0, minute = 0) =>
    Date.UTC(year, month - 1, day, hour - 9, minute);

  it('8w goes back 56 days, whatever the time zone', () => {
    expect(periodRange('8w', now, 'UTC')).toEqual({ from: now - 56 * 24 * HOUR, to: now });
    expect(periodRange('8w', now, SP)).toEqual({ from: now - 56 * 24 * HOUR, to: now });
  });

  it('6m goes back six calendar months', () => {
    expect(periodRange('6m', now, 'UTC')).toEqual({
      from: Date.UTC(2026, 3, 19, 12, 0, 0),
      to: now,
    });
  });

  it('6m clamps the day to the last day of the target month', () => {
    const end = Date.UTC(2026, 7, 31, 8, 0, 0);

    expect(periodRange('6m', end, 'UTC').from).toBe(Date.UTC(2026, 1, 28, 8, 0, 0));
  });

  it('6m crosses the year', () => {
    expect(periodRange('6m', Date.UTC(2026, 2, 15, 0, 0, 0), 'UTC').from).toBe(
      Date.UTC(2025, 8, 15, 0, 0, 0),
    );
  });

  it('all has no start', () => {
    expect(periodRange('all', now, SP)).toEqual({ from: null, to: now });
  });

  describe('6m in the calendar of the person', () => {
    // Na virada do ano a conta em UTC por acaso dá o mesmo instante (dezembro e janeiro caem em meses de destino de
    // tamanho igual): estes casos fixam o resultado certo, mas não distinguem as duas contas.
    it.each([
      ['31/12 at 23:30 in UTC-3', SP, sp(2026, 12, 31, 23, 30), sp(2026, 6, 30, 23, 30)],
      ['01/01 at 00:30 in UTC-3', SP, sp(2027, 1, 1, 0, 30), sp(2026, 7, 1, 0, 30)],
      [
        '31/12 at 23:30 in UTC+9',
        'Asia/Tokyo',
        tokyo(2026, 12, 31, 23, 30),
        tokyo(2026, 6, 30, 23, 30),
      ],
      ['01/01 at 00:30 in UTC+9', 'Asia/Tokyo', tokyo(2027, 1, 1, 0, 30), tokyo(2026, 7, 1, 0, 30)],
    ])('starts at the same local time six months back: %s', (_name, zone, at, from) => {
      expect(periodRange('6m', at, zone)).toEqual({ from, to: at });
    });

    it('uses the local day, not the UTC one, when they fall in different months (UTC-3)', () => {
      // 28/02 às 23:30 em Brasília já é 01/03 em UTC: seis meses antes é 28/08, e não 31/08 (conta em UTC).
      const at = sp(2026, 2, 28, 23, 30);

      expect(periodRange('6m', at, SP).from).toBe(sp(2025, 8, 28, 23, 30));
      expect(periodRange('6m', at, 'UTC').from).toBe(Date.UTC(2025, 8, 1, 2, 30));
    });

    it('uses the local day, not the UTC one, when they fall in different months (UTC+9)', () => {
      // 01/03 às 00:30 em Tóquio ainda é 28/02 em UTC: seis meses antes é 01/09, e não 28/08 (conta em UTC).
      const at = tokyo(2026, 3, 1, 0, 30);

      expect(periodRange('6m', at, 'Asia/Tokyo').from).toBe(tokyo(2025, 9, 1, 0, 30));
    });

    it('clamps the day in the local month: 31/08 in Tokyo goes back to 28/02', () => {
      const at = tokyo(2026, 8, 31, 1, 0);

      expect(periodRange('6m', at, 'Asia/Tokyo').from).toBe(tokyo(2026, 2, 28, 1, 0));
    });

    it('keeps the local clock time across a daylight saving change (New York)', () => {
      // 15/12 ao meio-dia é horário de inverno (UTC-5); seis meses antes, 15/06 ao meio-dia, é de verão (UTC-4).
      const at = Date.UTC(2026, 11, 15, 17, 0);

      expect(periodRange('6m', at, NY).from).toBe(Date.UTC(2026, 5, 15, 16, 0));
    });

    it('uses the time zone of the device when none is given', () => {
      expect(periodRange('6m', now).from).toBe(periodRange('6m', now, deviceTimeZone()).from);
    });
  });
});
