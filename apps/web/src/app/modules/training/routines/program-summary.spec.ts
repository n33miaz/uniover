import { daysText, isProgramTemplate, programSummary } from './program-summary';

describe('programSummary', () => {
  it('lists one routine per day, without the day prefix', () => {
    expect(
      programSummary([
        { name: 'Segunda · Peito, ombros e tríceps', weekdays: [1] },
        { name: 'Terça · Costas e bíceps', weekdays: [2] },
        { name: 'Quarta · Pernas A', weekdays: [3] },
      ]),
    ).toBe('Seg Peito, ombros e tríceps · Ter Costas e bíceps · Qua Pernas A');
  });

  it('drops the trailing parenthesis of the routine name', () => {
    expect(
      programSummary([
        { name: 'A · Corpo inteiro (segunda)', weekdays: [1] },
        { name: 'B · Corpo inteiro (quarta)', weekdays: [3] },
      ]),
    ).toBe('Seg Corpo inteiro · Qua Corpo inteiro');
  });

  it('says the routines alternate when they share the training days', () => {
    expect(
      programSummary([
        { name: 'A · Empurrar e quadríceps', weekdays: [1, 2, 3, 4, 5] },
        { name: 'B · Puxar e posterior', weekdays: [1, 2, 3, 4, 5] },
      ]),
    ).toBe('Seg–sex alterna Empurrar e quadríceps / Puxar e posterior');
  });
});

describe('daysText', () => {
  it('uses a range for consecutive days and a list otherwise', () => {
    expect(daysText([1, 2, 3, 4, 5])).toBe('Seg–sex');
    expect(daysText([1, 3, 5])).toBe('Seg, qua, sex');
    expect(daysText([2])).toBe('Ter');
  });
});

describe('isProgramTemplate', () => {
  const day = (weekdays: number[]) => ({ name: 'A', weekdays });

  it('accepts templates that declare the days and refuses the historical one', () => {
    expect(isProgramTemplate({ id: 'abc', routines: [day([1]), day([3])] })).toBe(true);
    expect(isProgramTemplate({ id: 'historical-ab', routines: [day([1])] })).toBe(false);
    expect(isProgramTemplate({ id: 'livre', routines: [day([])] })).toBe(false);
  });
});
