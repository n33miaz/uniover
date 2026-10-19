import { type CsvColumn, CSV_BOM, buildCsv, neutralizeFormula } from './csv';

const COLUMNS: readonly CsvColumn[] = [
  { key: 'name' },
  { key: 'kg', numeric: true },
  { key: 'note' },
];

describe('neutralizeFormula', () => {
  it.each(['=2+2', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1', '=HYPERLINK("x")'])(
    'puts an apostrophe before a text that would start a formula: %j',
    (text) => {
      expect(neutralizeFormula(text)).toBe(`'${text}`);
    },
  );

  it.each(['', 'Supino', '2+2', ' =2+2', 'a=b', "'=1", '40,5'])('leaves %j as it is', (text) => {
    expect(neutralizeFormula(text)).toBe(text);
  });
});

describe('buildCsv', () => {
  it('starts with the byte order mark, has the header, and ends each line with CRLF', () => {
    const csv = buildCsv(COLUMNS, [{ name: 'Supino', kg: 40, note: 'ok' }]);

    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(CSV_BOM).toBe('﻿');
    expect(csv).toBe(`${CSV_BOM}name,kg,note\r\nSupino,40,ok\r\n`);
  });

  it('has only the header for no rows', () => {
    expect(buildCsv(COLUMNS, [])).toBe(`${CSV_BOM}name,kg,note\r\n`);
  });

  it('keeps the accents as they are (UTF-8)', () => {
    expect(buildCsv(COLUMNS, [{ name: 'Tríceps na polia', kg: 25, note: 'ação' }])).toContain(
      'Tríceps na polia,25,ação',
    );
  });

  it('quotes a field with a comma, a quote or a line break, doubling the quotes (RFC 4180)', () => {
    const csv = buildCsv(COLUMNS, [
      { name: 'Remada, curvada', kg: 50, note: 'disse "ufa"' },
      { name: 'Linha', kg: 1, note: 'um\ndois' },
      { name: 'Retorno', kg: 1, note: 'um\r\ndois' },
    ]);

    expect(csv).toContain('"Remada, curvada",50,"disse ""ufa"""\r\n');
    expect(csv).toContain('Linha,1,"um\ndois"\r\n');
    expect(csv).toContain('Retorno,1,"um\r\ndois"\r\n');
  });

  it("neutralizes a text cell that would be a formula: =2+2 becomes '=2+2", () => {
    const csv = buildCsv(COLUMNS, [
      { name: '=2+2', kg: 1, note: '@cmd' },
      { name: '-menos', kg: 1, note: '+mais' },
      { name: '\t=tab', kg: 1, note: 'normal' },
    ]);

    expect(csv).toContain("'=2+2,1,'@cmd\r\n");
    expect(csv).toContain("'-menos,1,'+mais\r\n");
    expect(csv).toContain("'\t=tab,1,normal\r\n");
  });

  it('neutralizes before quoting: a formula with a comma stays one quoted cell with the apostrophe inside', () => {
    expect(buildCsv(COLUMNS, [{ name: '=SOMA(1,2)', kg: 1, note: '' }])).toContain(
      '"\'=SOMA(1,2)",1,\r\n',
    );
  });

  it('does not touch the numeric columns, which use a decimal point and never get an apostrophe', () => {
    const csv = buildCsv(COLUMNS, [
      { name: 'a', kg: 42.5, note: '' },
      { name: 'b', kg: -5, note: '' },
      { name: 'c', kg: 0, note: '' },
    ]);

    expect(csv).toContain('a,42.5,\r\n');
    expect(csv).toContain('b,-5,\r\n');
    expect(csv).toContain('c,0,\r\n');
  });

  it('leaves empty what is null, undefined or not a finite number in a numeric column', () => {
    const csv = buildCsv(COLUMNS, [
      { name: 'a', kg: null, note: null },
      { name: 'b', kg: undefined },
      { name: 'c', kg: Number.NaN, note: 'x' },
      { name: 'd', kg: Number.POSITIVE_INFINITY, note: 'x' },
    ]);

    expect(csv).toContain('a,,\r\n');
    expect(csv).toContain('b,,\r\n');
    expect(csv).toContain('c,,x\r\n');
    expect(csv).toContain('d,,x\r\n');
  });
});
