/**
 * CSV das séries, no formato do RFC 4180: campos separados por vírgula, linhas por CRLF, aspas dobradas dentro de campo
 * entre aspas. Ponto como separador decimal e UTF-8 **com** marca de ordem de bytes (para a planilha reconhecer os
 * acentos). Funções puras.
 *
 * Proteção contra fórmula: planilha trata célula de texto que começa com `=`, `+`, `-`, `@`, tabulação ou retorno como
 * fórmula, e uma anotação como `=2+2` (ou pior) executaria ao abrir o arquivo. Essas células de texto ganham um apóstrofo
 * na frente. As colunas numéricas ficam de fora: são números nossos, nunca texto digitado.
 */

export const CSV_BOM = '﻿';

const CRLF = '\r\n';
const FORMULA_START = /^[=+\-@\t\r]/;

export interface CsvColumn {
  readonly key: string;
  /** Coluna numérica: formatada com ponto decimal, sem proteção de fórmula. */
  readonly numeric?: boolean;
}

export type CsvValue = string | number | null | undefined;

/** Texto que começaria uma fórmula na planilha ganha um apóstrofo na frente. */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function textField(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  return quote(neutralizeFormula(String(value)));
}

function numericField(value: CsvValue): string {
  if (value === null || value === undefined || value === '') return '';
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? String(number) : '';
}

/** O CSV inteiro: a linha de cabeçalho (os nomes das colunas) e uma linha por registro; começa com a marca de ordem de bytes. */
export function buildCsv(
  columns: readonly CsvColumn[],
  rows: readonly Readonly<Record<string, CsvValue>>[],
): string {
  const lines = [columns.map((column) => column.key).join(',')];
  for (const row of rows) {
    lines.push(
      columns
        .map((column) =>
          column.numeric ? numericField(row[column.key]) : textField(row[column.key]),
        )
        .join(','),
    );
  }
  return CSV_BOM + lines.join(CRLF) + CRLF;
}
