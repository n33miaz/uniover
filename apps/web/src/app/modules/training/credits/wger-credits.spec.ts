import { TestBed } from '@angular/core/testing';
import { localExercise, setupTraining } from '../data/sync/training-test-kit';
import { WgerCreditsReader } from './wger-credits';

const CC_BY_SA = 'https://creativecommons.org/licenses/by-sa/4.0/';

function wger(id: string, overrides: Parameters<typeof localExercise>[1] = {}) {
  return localExercise(id, {
    source: 'wger',
    license: 'CC-BY-SA 4',
    licenseAuthor: 'Ana',
    licenseUrl: CC_BY_SA,
    ...overrides,
  });
}

async function readWith(rows: ReturnType<typeof localExercise>[]) {
  // O leitor abre o banco da conta em uso (a conta de teste do kit), como a tela de créditos fora do módulo faz.
  const { trainingDb } = setupTraining();
  await trainingDb.exercises.bulkPut(rows);
  return TestBed.inject(WgerCreditsReader).read();
}

describe('WgerCreditsReader', () => {
  it('is empty when the catalog has no exercise from wger', async () => {
    expect(await readWith([localExercise('seed', { license: null })])).toEqual([]);
  });

  it('is empty when the local database has no exercise at all', async () => {
    expect(await readWith([])).toEqual([]);
  });

  it('groups the exercises by author and license and counts them', async () => {
    const credits = await readWith([
      wger('a'),
      wger('b'),
      wger('c', { licenseAuthor: 'Bruno' }),
      wger('d', {
        license: 'CC-BY-SA 3',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
      }),
    ]);
    expect(credits).toEqual([
      {
        author: 'Ana',
        license: 'CC-BY-SA 3',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
        count: 1,
      },
      { author: 'Ana', license: 'CC-BY-SA 4', licenseUrl: CC_BY_SA, count: 2 },
      { author: 'Bruno', license: 'CC-BY-SA 4', licenseUrl: CC_BY_SA, count: 1 },
    ]);
  });

  it('ignores other sources, deleted exercises and rows without author or license', async () => {
    const credits = await readWith([
      localExercise('own', { source: 'own', license: 'CC0', licenseAuthor: 'Eu' }),
      wger('deleted', { deleted: true }),
      wger('no-author', { licenseAuthor: null }),
      wger('blank-author', { licenseAuthor: '  ' }),
      wger('no-license', { license: null }),
      wger('ok'),
    ]);
    expect(credits).toEqual([
      { author: 'Ana', license: 'CC-BY-SA 4', licenseUrl: CC_BY_SA, count: 1 },
    ]);
  });

  it('keeps only https license links', async () => {
    const credits = await readWith([
      wger('http', { licenseAuthor: 'A', licenseUrl: 'http://example.com/l' }),
      wger('script', { licenseAuthor: 'B', licenseUrl: 'javascript:alert(1)' }),
      wger('junk', { licenseAuthor: 'C', licenseUrl: 'não é endereço' }),
      wger('empty', { licenseAuthor: 'D', licenseUrl: null }),
      wger('https', { licenseAuthor: 'E' }),
    ]);
    expect(credits.map((credit) => [credit.author, credit.licenseUrl])).toEqual([
      ['A', null],
      ['B', null],
      ['C', null],
      ['D', null],
      ['E', CC_BY_SA],
    ]);
  });
});
