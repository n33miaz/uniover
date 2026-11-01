/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EQUIPMENT_IDS,
  RECORD_TYPES,
  equipmentLabel,
  isEquipmentId,
  isMuscleId,
  isRecordType,
  muscleGroupOf,
} from './taxonomy';

// Os testes rodam a partir de apps/web; a semente do catálogo fica na API, fora do projeto.
const SEED_DIR = resolve(
  process.cwd(),
  '../api/src/Modules/Training/UniOver.Modules.Training/Catalog/Seed',
);

interface SeedRow {
  readonly slug: string;
  readonly source?: string;
  readonly name: string;
  readonly instructions: readonly string[];
  readonly primaryMuscles: readonly string[];
  readonly secondaryMuscles: readonly string[];
  readonly equipment: string;
  readonly recordType: string;
}

const rows = (
  JSON.parse(readFileSync(resolve(SEED_DIR, 'exercises.pt-br.json'), 'utf8')) as {
    exercises: SeedRow[];
  }
).exercises;
const own = rows.filter((row) => row.source === 'uniover');
const LOWER_CASE_WORDS = new Set(['com', 'na', 'no', 'de', 'do', 'da', 'nos', 'e', 'a', 'o']);

describe('catalog seed: exercises written by UniOver', () => {
  it('adds the whole proposed list', () => {
    expect(own).toHaveLength(37);
    expect(rows.length).toBeGreaterThanOrEqual(307);
  });

  it('gives every one a name in Title Case, a muscle group, an equipment and a record type', () => {
    for (const row of own) {
      expect(row.name.trim(), row.slug).not.toBe('');
      for (const word of row.name.split(/\s+/)) {
        const first = word.replace(/^\(/, '')[0];
        if (!LOWER_CASE_WORDS.has(word))
          expect(first, `${row.slug}: ${word}`).toBe(first.toUpperCase());
      }
      expect(row.primaryMuscles.length, row.slug).toBeGreaterThan(0);
      for (const muscle of row.primaryMuscles) {
        expect(isMuscleId(muscle), `${row.slug}: ${muscle}`).toBe(true);
        expect(muscleGroupOf(muscle), `${row.slug}: ${muscle}`).toBeDefined();
      }
      for (const muscle of row.secondaryMuscles) expect(isMuscleId(muscle), row.slug).toBe(true);
      expect(isEquipmentId(row.equipment), `${row.slug}: ${row.equipment}`).toBe(true);
      expect(equipmentLabel(row.equipment), row.slug).not.toBe(row.equipment);
      expect(isRecordType(row.recordType), `${row.slug}: ${row.recordType}`).toBe(true);
      expect(row.instructions.length, row.slug).toBeGreaterThanOrEqual(3);
    }
  });

  it('uses the new equipment (kettlebell, band, cardio) and records cardio by time', () => {
    for (const id of ['kettlebell', 'band', 'cardio']) {
      expect(EQUIPMENT_IDS).toContain(id);
      expect(
        own.some((row) => row.equipment === id),
        id,
      ).toBe(true);
    }
    const cardio = own.filter((row) => row.equipment === 'cardio');
    expect(cardio.map((row) => row.name)).toEqual([
      'Pular Corda',
      'Esteira',
      'Bicicleta Ergométrica',
      'Elíptico (Transport)',
      'Remo Ergométrico',
    ]);
    expect(cardio.every((row) => row.recordType === 'time')).toBe(true);
    expect(RECORD_TYPES).toContain('time');
  });

  it('keeps names and slugs unique across the whole catalog', () => {
    expect(new Set(rows.map((row) => row.slug)).size).toBe(rows.length);
    const folded = rows.map((row) => row.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
    expect(new Set(folded).size).toBe(rows.length);
  });
});

describe('routine templates', () => {
  it('only cite exercises of the catalog and now cover glutes, lower back, adductors and abductors', () => {
    const templates = (
      JSON.parse(readFileSync(resolve(SEED_DIR, 'routine-templates.json'), 'utf8')) as {
        items: { routines: { items: { exerciseSlug: string }[] }[] }[];
      }
    ).items;
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    const used = templates.flatMap((t) =>
      t.routines.flatMap((r) => r.items.map((i) => i.exerciseSlug)),
    );
    for (const slug of used) expect(bySlug.has(slug), slug).toBe(true);
    const muscles = new Set(used.flatMap((slug) => bySlug.get(slug)!.primaryMuscles));
    for (const muscle of ['glutes', 'lower_back', 'adductors', 'abductors']) {
      expect(muscles.has(muscle), muscle).toBe(true);
    }
  });
});
