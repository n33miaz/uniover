/// <reference types="node" />
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXERCISE_ILLUSTRATIONS,
  EVERKINETIC_COMMIT,
  OPEN_ART_COMMIT,
  OPEN_ART_PREFIX,
  illustrationFor,
  illustrationUrl,
} from './illustration-map';

// Os testes rodam a partir de apps/web: o material de terceiros fica dentro do app (o Angular só publica de
// dentro do workspace) e a semente do catálogo fica na API, fora do projeto.
const REPO = resolve(process.cwd(), '../..');
const ART_ROOT = resolve(process.cwd(), 'assets-third-party/everkinetic');
const ART_DIR = resolve(ART_ROOT, 'svg');
const PNG_DIR = resolve(ART_ROOT, 'png');
// Os originais (SVG e PNG) não são publicados: o app serve a adaptação leve (WebP) que fica em outra pasta.
const DERIVED_DIR = resolve(process.cwd(), 'assets-derived/everkinetic');
// O Open Exercise Art tem pasta própria (SVG originais e adaptação), com os arquivos prefixados por "oea-".
const OPEN_ART_ROOT = resolve(process.cwd(), 'assets-third-party/open-exercise-art');
const OPEN_ART_DIR = resolve(OPEN_ART_ROOT, 'svg');
const OPEN_ART_DERIVED_DIR = resolve(process.cwd(), 'assets-derived/open-exercise-art');
const isOpenArt = (file: string) => file.startsWith(OPEN_ART_PREFIX);
const artPath = (file: string) =>
  resolve(isOpenArt(file) ? OPEN_ART_DERIVED_DIR : DERIVED_DIR, file);
const originalOf = (file: string) => file.replace(/\.webp$/, '.png');
// Figuras de origem SVG: NNNN-relaxation.webp e NNNN-tension.webp. As de origem PNG: NOME-1.webp e NOME-2.webp.
const SVG_FRAME = /^(\d{4})-(relaxation|tension)\.webp$/;
// Tamanho único de todas as figuras e peso máximo de cada arquivo.
const FRAME_SIZE = { width: 536, height: 550 };
const MAX_FRAME_BYTES = 20_000;
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
    expect(entries.length).toBeGreaterThan(200);
  });

  it('only cites files that exist in the third-party and derived folders', () => {
    const missing = entries.flatMap(([slug, entry]) =>
      entry.frames.filter((file) => !existsSync(artPath(file))).map((f) => `${slug}: ${f}`),
    );
    expect(missing).toEqual([]);
  });

  it('keeps no file in the folders that the map does not use', { timeout: 30_000 }, () => {
    const used = new Set<string>(entries.flatMap(([, entry]) => entry.frames));
    const unused = [
      ...readdirSync(DERIVED_DIR).filter((file) => file.endsWith('.webp') && !used.has(file)),
      ...readdirSync(OPEN_ART_DERIVED_DIR).filter(
        (file) => file.endsWith('.webp') && !used.has(file),
      ),
    ];
    // Cada SVG do Open Exercise Art guardado tem a sua adaptação citada pelo mapa.
    const openArtWithoutUse = readdirSync(OPEN_ART_DIR).filter(
      (file) => !used.has(`${OPEN_ART_PREFIX}${file.replace(/\.svg$/, '.webp')}`),
    );
    expect(openArtWithoutUse).toEqual([]);
    // Cada original (par de SVG, PNG solto) tem a sua adaptação citada pelo mapa.
    const svgWithoutUse = readdirSync(ART_DIR).filter(
      (file) => !used.has(file.replace(/\.svg$/, '.webp')),
    );
    const pngWithoutUse = readdirSync(PNG_DIR).filter(
      (file) => !used.has(file.replace(/\.png$/, '.webp')),
    );
    expect(unused).toEqual([]);
    expect(svgWithoutUse).toEqual([]);
    expect(pngWithoutUse).toEqual([]);
  });

  it(
    'publishes every Open Exercise Art figure as a light WebP of the same size, made from the originals',
    { timeout: 30_000 },
    () => {
      const derived = readdirSync(OPEN_ART_DERIVED_DIR).filter((file) => file.endsWith('.webp'));
      expect(derived.length).toBe(readdirSync(OPEN_ART_DIR).length);
      for (const file of derived) {
        const original = resolve(
          OPEN_ART_DIR,
          file.slice(OPEN_ART_PREFIX.length).replace(/\.webp$/, '.svg'),
        );
        expect(existsSync(original), file).toBe(true);
        const bytes = readFileSync(resolve(OPEN_ART_DERIVED_DIR, file));
        expect(bytes.toString('ascii', 0, 4), file).toBe('RIFF');
        expect(bytes.toString('ascii', 8, 12), file).toBe('WEBP');
        expect(bytes.toString('ascii', 12, 16), file).toBe('VP8 ');
        expect(bytes.readUInt16LE(26) & 0x3fff, file).toBe(FRAME_SIZE.width);
        expect(bytes.readUInt16LE(28) & 0x3fff, file).toBe(FRAME_SIZE.height);
        expect(bytes.length, file).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      }
    },
  );

  it(
    'publishes every Everkinetic figure as a light WebP of the same size, made from the originals',
    { timeout: 30_000 },
    () => {
      const derived = readdirSync(DERIVED_DIR).filter((file) => file.endsWith('.webp'));
      expect(derived.length).toBe(readdirSync(PNG_DIR).length + readdirSync(ART_DIR).length);
      for (const file of derived) {
        const original = SVG_FRAME.test(file)
          ? resolve(ART_DIR, file.replace(/\.webp$/, '.svg'))
          : resolve(PNG_DIR, originalOf(file));
        expect(existsSync(original), file).toBe(true);
        const bytes = readFileSync(resolve(DERIVED_DIR, file));
        // Cabeçalho RIFF/WEBP com quadro de perda leve ('VP8 '): largura e altura em 14 bits cada.
        expect(bytes.toString('ascii', 0, 4), file).toBe('RIFF');
        expect(bytes.toString('ascii', 8, 12), file).toBe('WEBP');
        expect(bytes.toString('ascii', 12, 16), file).toBe('VP8 ');
        expect(bytes.readUInt16LE(26) & 0x3fff, file).toBe(FRAME_SIZE.width);
        expect(bytes.readUInt16LE(28) & 0x3fff, file).toBe(FRAME_SIZE.height);
        expect(bytes.length, file).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      }
    },
  );

  it('serves every cited frame at the standard size and weight', { timeout: 30_000 }, () => {
    for (const [slug, entry] of entries) {
      for (const file of entry.frames) {
        expect(file, slug).toMatch(/\.webp$/);
        const bytes = readFileSync(artPath(file));
        expect(
          [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff],
          `${slug}: ${file}`,
        ).toEqual([FRAME_SIZE.width, FRAME_SIZE.height]);
        expect(bytes.length, `${slug}: ${file}`).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      }
    }
  });

  it('only cites slugs that exist in the catalog seed', () => {
    const unknown = entries.map(([slug]) => slug).filter((slug) => !seedSlugs.has(slug));
    expect(unknown).toEqual([]);
  });

  it('lets a figure serve two slugs only when the extras are marked as variations', () => {
    const owners = new Map<string, string[]>();
    for (const [slug, entry] of entries) {
      const key = entry.frames.join('|');
      owners.set(key, [...(owners.get(key) ?? []), slug]);
    }
    const unmarked = [...owners.values()]
      .filter((slugs) => slugs.length > 1)
      .map((slugs) => slugs.filter((slug) => illustrationFor(slug)?.variation !== true))
      .filter((slugs) => slugs.length > 1);
    expect(unmarked).toEqual([]);
  });

  it('uses two different poses of the same exercise', () => {
    for (const [slug, entry] of entries) {
      if (entry.frames.length !== 2) continue;
      const [start, end] = entry.frames;
      expect(start, slug).not.toBe(end);
      if (SVG_FRAME.test(start)) {
        expect(start.split('-')[0], slug).toBe(end.split('-')[0]);
        expect(start, slug).toMatch(/^\d{4}-relaxation\.webp$/);
        expect(end, slug).toMatch(/^\d{4}-tension\.webp$/);
        continue;
      }
      expect(start.replace(/-[12]\.webp$/, ''), slug).toBe(end.replace(/-[12]\.webp$/, ''));
      expect([start, end].map((file) => file.match(/-([12])\.webp$/)?.[1]).sort()).toEqual([
        '1',
        '2',
      ]);
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
      .filter(([, entry]) => entry.source === 'everkinetic')
      .filter(([, entry]) => {
        if (!SVG_FRAME.test(entry.frames[0])) {
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
    expect(OPEN_ART_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    for (const entry of Object.values(EXERCISE_ILLUSTRATIONS)) {
      if (entry.source === 'everkinetic') {
        expect(entry.sourceUrl).toContain(EVERKINETIC_COMMIT);
        expect(entry.sourceUrl.startsWith('https://github.com/everkinetic/data/')).toBe(true);
      } else {
        expect(entry.sourceUrl).toContain(OPEN_ART_COMMIT);
        expect(
          entry.sourceUrl.startsWith('https://github.com/AlexMollard/Open-Exercise-Art/blob/'),
        ).toBe(true);
      }
    }
  });

  it('gives every Open Exercise Art figure one pose, the title of its SVG and a source link to that file', () => {
    const openArt = entries.filter(([, entry]) => entry.source === 'open-exercise-art');
    expect(openArt.length).toBeGreaterThan(50);
    for (const [slug, entry] of openArt) {
      expect(entry.frames, slug).toHaveLength(1);
      const [file] = entry.frames;
      expect(file, slug).toMatch(new RegExp(`^${OPEN_ART_PREFIX}[a-z0-9-]+\\.webp$`));
      const name = file.slice(OPEN_ART_PREFIX.length).replace(/\.webp$/, '');
      expect(entry.sourceUrl, slug).toBe(
        `https://github.com/AlexMollard/Open-Exercise-Art/blob/${OPEN_ART_COMMIT}/svg/${name}.svg`,
      );
      const svg = readFileSync(resolve(OPEN_ART_DIR, `${name}.svg`), 'utf8');
      expect(svg, slug).toContain(`<title>${entry.title}</title>`);
    }
  });

  it('keeps the Open Exercise Art originals as downloaded, with license and notice beside them', () => {
    expect(readFileSync(resolve(OPEN_ART_ROOT, 'NOTICE'), 'utf8')).toContain(OPEN_ART_COMMIT);
    expect(readFileSync(resolve(OPEN_ART_ROOT, 'LICENSE'), 'utf8')).toContain(
      'Attribution-ShareAlike 4.0',
    );
    for (const file of readdirSync(OPEN_ART_DIR)) {
      expect(readFileSync(resolve(OPEN_ART_DIR, file), 'utf8'), file).toContain('currentColor');
    }
  });

  it('marks the figures borrowed from an equivalent exercise as variations', () => {
    const variations = entries.filter(([, entry]) => entry.variation).map(([slug]) => slug);
    expect(variations.sort()).toEqual(
      [
        'abdominal-na-polia',
        'afundo-com-halteres',
        'barra-fixa-com-pegada-neutra',
        'crucifixo-inverso-na-polia',
        'remada-curvada-com-barra',
        'remada-unilateral-com-halter',
        'rosca-inversa-com-barra',
        'stiff-com-barra',
        'stiff-com-halteres',
        'stiff-no-smith',
        'supino-articulado-na-maquina',
      ].sort(),
    );
    // A figura da variação é a de outro exercício: o par se repete com o do exercício original.
    expect(illustrationFor('stiff-com-barra')?.frames).toEqual(
      illustrationFor('levantamento-terra-romeno-com-barra')?.frames,
    );
    expect(illustrationFor('supino-articulado-na-maquina')?.frames).toEqual(
      illustrationFor('supino-na-maquina')?.frames,
    );
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

  it('leaves movements without any figure unillustrated', () => {
    for (const slug of [
      // Sem figura em nenhuma fonte (as variações recusadas e os exercícios sem desenho).
      'panturrilha-burro-na-maquina',
      'abdominal-obliquo-no-chao',
      'elevacao-pelvica-na-maquina',
      'rosca-bayesiana-na-polia',
      'desenvolvimento-com-kettlebell',
      'levantamento-turco',
      'caminhada-do-fazendeiro',
    ]) {
      expect(illustrationFor(slug), slug).toBeUndefined();
    }
  });

  it('gives the lunges and the ab roller the Open Exercise Art figure, with a single pose', () => {
    for (const [slug, figure] of [
      ['passada-com-barra', 'barbell-lunge'],
      ['passada-com-peso-do-corpo', 'forward-lunge'],
      ['abdominal-com-rolo', 'ab-wheel-rollout'],
    ]) {
      expect(illustrationFor(slug)?.frames, slug).toEqual([`${OPEN_ART_PREFIX}${figure}.webp`]);
      expect(illustrationFor(slug)?.variation, slug).toBeUndefined();
    }
  });

  it('illustrates the incline curls and the one-arm row with the matching source drawings', () => {
    expect(illustrationFor('rosca-inclinada-com-halteres')?.frames).toEqual([
      '0228-relaxation.webp',
      '0228-tension.webp',
    ]);
    expect(illustrationFor('rosca-martelo-inclinada-com-halteres')?.frames).toEqual([
      '0231-relaxation.webp',
      '0231-tension.webp',
    ]);
    expect(illustrationFor('remada-unilateral-com-halter')?.frames).toEqual([
      '0024-relaxation.webp',
      '0024-tension.webp',
    ]);
  });

  it('builds the same-origin address of a frame', () => {
    expect(illustrationUrl('0042-relaxation.webp')).toBe('/exercise-art/0042-relaxation.webp');
  });
});
