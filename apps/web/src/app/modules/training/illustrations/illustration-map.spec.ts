/// <reference types="node" />
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXERCISE_ILLUSTRATIONS,
  EVERKINETIC_COMMIT,
  illustrationFor,
  illustrationUrl,
} from './illustration-map';

// Os testes rodam a partir de apps/web: o material de terceiros fica dentro do app (o Angular só publica de
// dentro do workspace) e a semente do catálogo fica na API, fora do projeto.
const REPO = resolve(process.cwd(), '../..');
const ART_ROOT = resolve(process.cwd(), 'assets-third-party/everkinetic');
const ART_DIR = resolve(ART_ROOT, 'svg');
const SEED = resolve(
  REPO,
  'apps/api/src/Modules/Training/UniOver.Modules.Training/Catalog/Seed/exercises.pt-br.json',
);

interface SeedFile {
  readonly exercises: readonly { readonly slug: string }[];
}
interface SourceExercise {
  readonly id_num: string;
  readonly title: string;
}

const entries = Object.entries(EXERCISE_ILLUSTRATIONS);
const seedSlugs = new Set(
  (JSON.parse(readFileSync(SEED, 'utf8')) as SeedFile).exercises.map((row) => row.slug),
);

describe('illustration map', () => {
  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it('only cites files that exist in the third-party folder', () => {
    const missing = entries.flatMap(([slug, entry]) =>
      entry.frames
        .filter((file) => !existsSync(resolve(ART_DIR, file)))
        .map((f) => `${slug}: ${f}`),
    );
    expect(missing).toEqual([]);
  });

  it('keeps no file in the folder that the map does not use', () => {
    const used = new Set(entries.flatMap(([, entry]) => entry.frames));
    const unused = readdirSync(ART_DIR).filter((file) => !used.has(file));
    expect(unused).toEqual([]);
  });

  it('only cites slugs that exist in the catalog seed', () => {
    const unknown = entries.map(([slug]) => slug).filter((slug) => !seedSlugs.has(slug));
    expect(unknown).toEqual([]);
  });

  it('never points two slugs at the same pair of files', () => {
    const owners = new Map<string, string>();
    const repeated: string[] = [];
    for (const [slug, entry] of entries) {
      const key = entry.frames.join('|');
      const previous = owners.get(key);
      if (previous !== undefined) repeated.push(`${previous} e ${slug}`);
      owners.set(key, slug);
    }
    expect(repeated).toEqual([]);
  });

  it('uses two different poses of the same exercise', () => {
    for (const [slug, entry] of entries) {
      const [start, end] = entry.frames;
      expect(start, slug).not.toBe(end);
      expect(start.split('-')[0], slug).toBe(end.split('-')[0]);
      expect(start, slug).toMatch(/^\d{4}-relaxation\.svg$/);
      expect(end, slug).toMatch(/^\d{4}-tension\.svg$/);
    }
  });

  it('keeps the title of the source exercise that the files belong to', () => {
    const source = JSON.parse(
      readFileSync(resolve(ART_ROOT, 'exercises.json'), 'utf8'),
    ) as SourceExercise[];
    const titles = new Map<string, string[]>();
    for (const row of source) {
      const list = titles.get(row.id_num) ?? [];
      list.push(row.title.replaceAll('�', "'"));
      titles.set(row.id_num, list);
    }
    const wrong = entries
      .filter(([, entry]) => !titles.get(entry.frames[0].slice(0, 4))?.includes(entry.title))
      .map(([slug, entry]) => `${slug}: ${entry.title}`);
    expect(wrong).toEqual([]);
  });

  it('points the source link at the pinned commit', () => {
    expect(EVERKINETIC_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    for (const entry of Object.values(EXERCISE_ILLUSTRATIONS)) {
      expect(entry.sourceUrl).toContain(EVERKINETIC_COMMIT);
      expect(entry.sourceUrl.startsWith('https://github.com/everkinetic/data/')).toBe(true);
    }
  });

  it('looks an illustration up by slug and answers nothing for the unknown', () => {
    expect(illustrationFor('supino-reto-com-barra')?.title).toBe('Bench Press');
    expect(illustrationFor('nao-existe')).toBeUndefined();
    expect(illustrationFor('constructor')).toBeUndefined();
  });

  it('builds the same-origin address of a frame', () => {
    expect(illustrationUrl('0042-relaxation.svg')).toBe('/exercise-art/0042-relaxation.svg');
  });
});
