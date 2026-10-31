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
const PNG_DIR = resolve(ART_ROOT, 'png');
// Os PNG originais são publicados na adaptação leve (WebP) que fica ao lado, em outra pasta.
const DERIVED_DIR = resolve(process.cwd(), 'assets-derived/everkinetic');
const artPath = (file: string) => resolve(file.endsWith('.webp') ? DERIVED_DIR : ART_DIR, file);
const originalOf = (file: string) => file.replace(/\.webp$/, '.png');
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
  readonly img?: readonly string[];
}

const entries = Object.entries(EXERCISE_ILLUSTRATIONS);

// Exercícios que só têm o par em PNG na origem (sem o par de SVG).
const PNG_ONLY = [
  'desenvolvimento-com-halteres',
  'puxada-aberta-na-polia',
  'desenvolvimento-arnold',
  'desenvolvimento-na-maquina',
  'desenvolvimento-sentado-com-barra',
  'elevacao-frontal-com-barra',
  'crucifixo-na-maquina-voador',
  'supino-inclinado-articulado-na-maquina',
  'barra-fixa-supinada',
  'triceps-frances-unilateral-com-halter',
];
const seedSlugs = new Set(
  (JSON.parse(readFileSync(SEED, 'utf8')) as SeedFile).exercises.map((row) => row.slug),
);

describe('illustration map', () => {
  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it('only cites files that exist in the third-party and derived folders', () => {
    const missing = entries.flatMap(([slug, entry]) =>
      entry.frames.filter((file) => !existsSync(artPath(file))).map((f) => `${slug}: ${f}`),
    );
    expect(missing).toEqual([]);
  });

  it('keeps no file in the folders that the map does not use', () => {
    const used = new Set(entries.flatMap(([, entry]) => entry.frames));
    const unused = [...readdirSync(ART_DIR), ...readdirSync(DERIVED_DIR)].filter(
      (file) => (file.endsWith('.svg') || file.endsWith('.webp')) && !used.has(file),
    );
    // Cada PNG original tem a sua adaptação citada pelo mapa.
    const originalsWithoutUse = readdirSync(PNG_DIR).filter(
      (file) => !used.has(file.replace(/\.png$/, '.webp')),
    );
    expect(unused).toEqual([]);
    expect(originalsWithoutUse).toEqual([]);
  });

  it('publishes the PNG pairs as light, same-size WebP made from the originals', () => {
    const derived = readdirSync(DERIVED_DIR).filter((file) => file.endsWith('.webp'));
    expect(derived.length).toBe(readdirSync(PNG_DIR).length);
    for (const file of derived) {
      expect(existsSync(resolve(PNG_DIR, originalOf(file))), file).toBe(true);
      const bytes = readFileSync(resolve(DERIVED_DIR, file));
      // Cabeçalho RIFF/WEBP com quadro de perda leve ('VP8 '): largura e altura em 14 bits cada.
      expect(bytes.toString('ascii', 0, 4), file).toBe('RIFF');
      expect(bytes.toString('ascii', 8, 12), file).toBe('WEBP');
      expect(bytes.toString('ascii', 12, 16), file).toBe('VP8 ');
      expect(bytes.readUInt16LE(26) & 0x3fff, file).toBe(536);
      expect(bytes.readUInt16LE(28) & 0x3fff, file).toBe(550);
      expect(bytes.length, file).toBeLessThan(40_000);
    }
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
      if (start.endsWith('.webp')) {
        expect(start.replace(/-[12]\.webp$/, ''), slug).toBe(end.replace(/-[12]\.webp$/, ''));
        expect([start, end].map((file) => file.match(/-([12])\.webp$/)?.[1]).sort()).toEqual([
          '1',
          '2',
        ]);
        continue;
      }
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
      .filter(([, entry]) => {
        if (entry.frames[0].endsWith('.webp')) {
          return !source.some(
            (row) =>
              row.title === entry.title &&
              entry.frames.every((file) => row.img?.includes(`_images/web/${originalOf(file)}`)),
          );
        }
        return !titles.get(entry.frames[0].slice(0, 4))?.includes(entry.title);
      })
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

  it('uses the light WebP pairs when the exact movement has no SVG pair', () => {
    expect(illustrationFor('desenvolvimento-com-halteres')?.frames).toEqual([
      'dumbbell-shoulder-press-1.webp',
      'dumbbell-shoulder-press-2.webp',
    ]);
    expect(illustrationFor('puxada-aberta-na-polia')?.frames).toEqual([
      'wide-grip-lat-pull-down-2.webp',
      'wide-grip-lat-pull-down-1.webp',
    ]);
    expect(illustrationFor('elevacao-frontal-com-barra')?.frames).toEqual([
      'front-barbell-raises-2.webp',
      'front-barbell-raises-1.webp',
    ]);
    for (const slug of PNG_ONLY) {
      const entry = illustrationFor(slug)!;
      // O crédito aponta para o PNG original, não para a adaptação.
      expect(entry.sourceUrl).toContain(`/src/images-web/${originalOf(entry.frames[0])}`);
    }
  });

  it('leaves movements without an exact pair unillustrated', () => {
    for (const slug of [
      'crucifixo-inverso-na-maquina',
      'remada-apoiada-no-banco-inclinado-com-halteres',
      'stiff-com-halteres',
      'supino-articulado-na-maquina',
      // Na origem a figura é de halteres, de pegada reta ou de um braço só: não é o mesmo exercício.
      'passada-com-barra',
      'barra-fixa-com-pegada-neutra',
      'crucifixo-inverso-na-polia',
    ]) {
      expect(illustrationFor(slug), slug).toBeUndefined();
    }
  });

  it('builds the same-origin address of a frame', () => {
    expect(illustrationUrl('0042-relaxation.svg')).toBe('/exercise-art/0042-relaxation.svg');
  });
});
