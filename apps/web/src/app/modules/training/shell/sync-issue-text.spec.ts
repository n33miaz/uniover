import { describeIssue, explainFailure } from './sync-issue-text';

const BASE = '/api/v1/training';

describe('describeIssue', () => {
  it('names the kind of write by the route, and the record by the body', () => {
    expect(describeIssue({ url: `${BASE}/routines/1`, body: { name: 'Treino A' } })).toEqual({
      kind: 'Rotina',
      name: 'Treino A',
      deleting: false,
    });
    expect(describeIssue({ url: `${BASE}/exercises/1`, body: { name: ' Remada ' } })).toMatchObject(
      {
        kind: 'Exercício',
        name: 'Remada',
      },
    );
    expect(describeIssue({ url: `${BASE}/exercises/1/step`, body: { stepKg: 2 } })).toMatchObject({
      kind: 'Salto de carga',
      name: null,
    });
    expect(describeIssue({ url: `${BASE}/sessions/1/sets/2`, body: {} }).kind).toBe('Série');
    expect(describeIssue({ url: `${BASE}/sessions/1`, body: {} }).kind).toBe('Treino');
    expect(describeIssue({ url: `${BASE}/goals/weekly`, body: {} }).kind).toBe('Meta');
  });

  it('says so when the write deletes the record', () => {
    expect(
      describeIssue({ url: `${BASE}/routines/1`, body: { name: 'A', deleted: true } }),
    ).toEqual({ kind: 'Apagar rotina', name: 'A', deleting: true });
  });

  it('falls back to a generic name for a route it does not know, and survives a missing body', () => {
    expect(describeIssue({ url: '/api/v1/outra/coisa', body: undefined })).toEqual({
      kind: 'Alteração',
      name: null,
      deleting: false,
    });
  });
});

describe('explainFailure', () => {
  it('explains the problems the app knows', () => {
    expect(explainFailure('http-422:client-clock-ahead')).toContain('relógio');
    expect(explainFailure('http-403:catalog-row-readonly')).toContain('catálogo');
    expect(explainFailure('http-404')).toContain('404');
  });

  it('keeps the HTTP code for the rest, and has a sentence when there is none', () => {
    expect(explainFailure('http-422:outro')).toContain('422');
    expect(explainFailure(null)).toBe('O servidor recusou esta alteração.');
  });
});
