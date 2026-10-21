import { ApiProblem, networkProblem } from './api-problem';
import {
  DISPLAY_NAME_INPUT_LIMIT,
  MAX_DISPLAY_NAME,
  describeDisplayNameFailure,
  displayNameCounterText,
  displayNameIssue,
  displayNameIssueText,
  displayNameLength,
  normalizeDisplayName,
} from './display-name';

describe('display name rules', () => {
  it('normalizes like the API: composed Unicode, trimmed, repeated spaces collapsed', () => {
    expect(normalizeDisplayName('  Ana   Maria ')).toBe('Ana Maria');
    expect(normalizeDisplayName('José')).toBe('José');
    // Espaço sem quebra também é espaço.
    expect(normalizeDisplayName('Ana  Maria')).toBe('Ana Maria');
  });

  it('counts code points of the normalized text, not UTF-16 units', () => {
    expect(displayNameLength('  Ana  ')).toBe(3);
    expect(displayNameLength('José')).toBe(4);
    // Um emoji vale 1 caractere (e ocupa 2 unidades do navegador).
    expect(displayNameLength('Ana \u{1F600}')).toBe(5);
    expect('Ana \u{1F600}'.length).toBe(6);
  });

  it('accepts exactly the maximum and refuses one more', () => {
    expect(displayNameIssue('a'.repeat(MAX_DISPLAY_NAME))).toBeNull();
    expect(displayNameIssue('a'.repeat(MAX_DISPLAY_NAME + 1))).toBe('too-long');
    // 60 emojis cabem na API (60 pontos de código) e passam de 60 unidades do navegador.
    expect(displayNameIssue('\u{1F600}'.repeat(MAX_DISPLAY_NAME))).toBeNull();
  });

  it('leaves room to type more than the limit (the field never cuts a name the API accepts)', () => {
    expect(DISPLAY_NAME_INPUT_LIMIT).toBeGreaterThanOrEqual(2 * MAX_DISPLAY_NAME);
  });

  it('refuses an empty name and one with only spaces', () => {
    expect(displayNameIssue('')).toBe('empty');
    expect(displayNameIssue('    ')).toBe('empty');
  });

  it('says what is wrong in words, never repeating what was typed', () => {
    expect(displayNameIssueText('empty')).toBe('Escreva como devemos te chamar.');
    expect(displayNameIssueText('too-long')).toBe('O nome pode ter até 60 caracteres.');
  });

  it('shows the counter as "n de 60", honest even past the limit', () => {
    expect(displayNameCounterText('Ana')).toBe('3 de 60');
    expect(displayNameCounterText('a'.repeat(63))).toBe('63 de 60');
    expect(displayNameCounterText('')).toBe('0 de 60');
  });
});

describe('describeDisplayNameFailure', () => {
  const problem = (status: number, fieldErrors = {}, retryAfter: number | null = null) =>
    new ApiProblem(status, '', 'x', null, null, retryAfter, fieldErrors);

  it('a 400 shows the message the API sent for the name, on the field', () => {
    const failure = describeDisplayNameFailure(
      problem(400, { displayName: ['Use só letras, números, espaços e emojis comuns.'] }),
    );
    expect(failure.kind).toBe('field');
    expect(failure.field).toBe('Use só letras, números, espaços e emojis comuns.');
  });

  it('reads the field key whatever its case', () => {
    expect(
      describeDisplayNameFailure(problem(400, { DisplayName: ['Informe seu nome.'] })).field,
    ).toBe('Informe seu nome.');
  });

  it('a 400 with no message for the field still explains, on the field', () => {
    const failure = describeDisplayNameFailure(problem(400));
    expect(failure.kind).toBe('field');
    expect(failure.field).toContain('não pode ser usado');
  });

  it('a 429 asks to wait for the time the API gave', () => {
    const failure = describeDisplayNameFailure(problem(429, {}, 30));
    expect(failure.kind).toBe('wait');
    expect(failure.field).toBeNull();
    expect(failure.heading).toBe('Muitas tentativas seguidas.');
    expect(failure.detail).toContain('30 segundos');
  });

  it('a 429 with no time still asks to wait', () => {
    const failure = describeDisplayNameFailure(problem(429));
    expect(failure.kind).toBe('wait');
    expect(failure.detail).toBe('Espere um pouco antes de tentar de novo.');
  });

  it('a 403 says the account has no access any more', () => {
    const failure = describeDisplayNameFailure(problem(403));
    expect(failure.kind).toBe('revoked');
    expect(failure.heading).toContain('não tem mais acesso');
  });

  it('no answer is a network problem and the name was not saved', () => {
    const failure = describeDisplayNameFailure(networkProblem());
    expect(failure.kind).toBe('network');
    expect(failure.detail).toContain('não foi salvo');
  });

  it.each([500, 502, 404])('a %s is a failure on our side', (status) => {
    expect(describeDisplayNameFailure(problem(status)).kind).toBe('failed');
  });

  it('something that is not an API answer is also a failure on our side', () => {
    expect(describeDisplayNameFailure(new Error('boom')).kind).toBe('failed');
  });
});
