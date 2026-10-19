import { TestBed } from '@angular/core/testing';
import { SAO_PAULO, at } from '../../domain/progress/progress-test-kit';
import { goalDto } from '../goals/goal-data-test-kit';
import { toLocalGoal } from '../goals/goal';
import { localSet, seedExerciseCatalog, session } from '../progress/progress-data-test-kit';
import type { WeekSummary } from '../progress/progress-repository';
import { createTrainingTestDb, localExercise, setupTraining } from '../sync/training-test-kit';
import { TRAINING_DB } from '../training-db';
import type { LocalRoutine } from '../routines/routine';
import { CSV_BOM } from './csv';
import { ExportDelivery } from './export-delivery';
import { type ExportSection, TRAINING_EXPORT_SECTIONS } from './export-sections';
import { EXPORT_VERSION, ExportService, SETS_CSV_COLUMNS } from './export-service';

class FakeDelivery {
  downloads: { blob: Blob; filename: string }[] = [];
  shares: { title?: string; text?: string }[] = [];

  download(blob: Blob, filename: string): void {
    this.downloads.push({ blob, filename });
  }

  async share(payload: { title?: string; text?: string }) {
    this.shares.push(payload);
    return 'shared' as const;
  }
}

function setup(extraSections: readonly ExportSection[] = []) {
  const training = setupTraining();
  const delivery = new FakeDelivery();
  TestBed.configureTestingModule({
    providers: [
      { provide: ExportDelivery, useValue: delivery },
      ...extraSections.map((section) => ({
        provide: TRAINING_EXPORT_SECTIONS,
        useValue: section,
        multi: true,
      })),
    ],
  });
  // Sem sessão a fila não envia (e só se pausa depois de configurar o módulo de teste).
  training.pause();
  return { ...training, delivery, service: TestBed.inject(ExportService) };
}

const routine = (
  id: string,
  name: string,
  overrides: Partial<LocalRoutine> = {},
): LocalRoutine => ({
  id,
  name,
  position: 0,
  active: true,
  note: '',
  items: [
    {
      id: `${id}-1`,
      exerciseId: 'supino',
      position: 0,
      targetSets: 4,
      repMin: 6,
      repMax: 10,
      restSeconds: 120,
      supersetGroup: null,
      note: '',
    },
  ],
  updatedAt: 1,
  clientUpdatedAt: 1,
  deletedAt: null,
  ...overrides,
});

/** Lê os bytes de um `Blob` (o `FileReader.readAsText` esconderia a marca de ordem de bytes). */
function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

async function seedEverything(t: ReturnType<typeof setup>) {
  const db = t.trainingDb;
  await seedExerciseCatalog(db);
  await db.exercises.put(
    localExercise('meu-supino', {
      source: 'own',
      sourceRef: null,
      name: 'Meu supino',
      primaryMuscles: ['chest'],
      stepKg: 2,
    }),
  );
  await db.exercises.put(
    localExercise('meu-apagado', { source: 'own', name: 'Apagado', deleted: true }),
  );
  await db.routines.bulkPut([
    routine('r1', 'A · Peito'),
    routine('r2', 'Apagada', { deletedAt: 5 }),
  ]);
  await db.sessions.bulkPut([
    session('s1', '2026-10-10', { routineId: 'r1', note: 'boa' }),
    session('s2', '2026-10-11', { deletedAt: 3 }),
  ]);
  await db.sets.bulkPut([
    localSet('x1', 's1', {
      exerciseId: 'supino',
      completedAt: at('2026-10-10', 9),
      weightKg: 42.5,
      reps: 8,
      rir: 2,
      rpe: 8,
    }),
    localSet('x2', 's1', {
      exerciseId: 'supino',
      position: 1,
      completedAt: at('2026-10-10', 9, 5),
      note: 'ficou "ótimo", sem dor',
    }),
    localSet('x3', 's1', {
      exerciseId: 'supino',
      position: 2,
      completedAt: at('2026-10-10', 9, 10),
      deletedAt: 9,
    }),
    localSet('x4', 's2', { exerciseId: 'supino', completedAt: at('2026-10-11', 9) }),
  ]);
  const goal = toLocalGoal(goalDto('exercise_e1rm', { exerciseId: 'supino', value: 55 }));
  const dead = toLocalGoal(goalDto('daily_kcal', { value: null, deleted: true }));
  await db.goals.bulkPut([goal!, dead!]);
}

describe('ExportService', () => {
  describe('buildJson', () => {
    it('has the header and one section per registered source, with only live data of the owner', async () => {
      const t = setup();
      await seedEverything(t);

      const document = await t.service.buildJson();

      expect(document).toMatchObject({
        app: 'uniover',
        module: 'training',
        exportVersion: 1,
        exportedAt: new Date(t.runtime.now()).toISOString(),
      });
      expect(EXPORT_VERSION).toBe(1);
      expect(Object.keys(document.sections)).toEqual([
        'exercises',
        'routines',
        'sessions',
        'sets',
        'goals',
      ]);

      const sections = document.sections as Record<string, { id?: string; kind?: string }[]>;
      // Só o exercício próprio e vivo; o catálogo se recria sozinho.
      expect(sections['exercises'].map((row) => row.id)).toEqual(['meu-supino']);
      expect(sections['routines'].map((row) => row.id)).toEqual(['r1']);
      expect(sections['sessions'].map((row) => row.id)).toEqual(['s1']);
      expect(sections['sets'].map((row) => row.id)).toEqual(['x1', 'x2']);
      expect(sections['goals']).toEqual([
        {
          kind: 'exercise_e1rm',
          exerciseId: 'supino',
          value: 55,
          updatedAt: new Date(toLocalGoal(goalDto('exercise_e1rm'))!.clientUpdatedAt).toISOString(),
        },
      ]);
    });

    it('carries the data itself: loads, repetitions, effort, notes and the routine items', async () => {
      const t = setup();
      await seedEverything(t);

      const sections = (await t.service.buildJson()).sections as Record<
        string,
        Record<string, unknown>[]
      >;

      expect(sections['sets'][0]).toMatchObject({
        sessionId: 's1',
        exerciseId: 'supino',
        setType: 'work',
        weightKg: 42.5,
        reps: 8,
        rir: 2,
        rpe: 8,
        note: null,
        completedAt: new Date(at('2026-10-10', 9)).toISOString(),
      });
      expect(sections['sets'][1]['note']).toBe('ficou "ótimo", sem dor');
      expect(sections['sessions'][0]).toMatchObject({
        routineId: 'r1',
        note: 'boa',
        finishedAt: expect.any(String),
      });
      expect((sections['routines'][0]['items'] as unknown[])[0]).toMatchObject({
        exerciseId: 'supino',
        targetSets: 4,
        repMin: 6,
        repMax: 10,
        restSeconds: 120,
      });
      expect(sections['exercises'][0]).toMatchObject({
        name: 'Meu supino',
        stepKg: 2,
        equipment: 'barbell',
      });
    });

    it('is valid JSON that survives a round trip', async () => {
      const t = setup();
      await seedEverything(t);

      const document = await t.service.buildJson();

      expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    });

    it('is a valid document with empty sections when there is no data', async () => {
      const t = setup();

      const document = await t.service.buildJson();

      expect(document.sections).toEqual({
        exercises: [],
        routines: [],
        sessions: [],
        sets: [],
        goals: [],
      });
    });

    it('accepts an extra section registered in the token, without editing the service', async () => {
      const body: ExportSection = { key: 'body', build: async () => [{ weightKg: 80 }] };
      const meals: ExportSection = { key: 'meals', build: async () => [] };
      const t = setup([body, meals]);

      const document = await t.service.buildJson();

      expect(Object.keys(document.sections)).toEqual([
        'exercises',
        'routines',
        'sessions',
        'sets',
        'goals',
        'body',
        'meals',
      ]);
      expect(document.sections['body']).toEqual([{ weightKg: 80 }]);
    });

    it('refuses two sections with the same name instead of losing one in silence', async () => {
      const twin: ExportSection = { key: 'sets', build: async () => [] };
      const t = setup([twin]);

      await expect(t.service.buildJson()).rejects.toThrow('sets');
    });
  });

  describe('buildSetsCsv', () => {
    it('has the BOM, the header of the task and one CRLF line per live set, oldest first', async () => {
      const t = setup();
      await seedEverything(t);

      const csv = await t.service.buildSetsCsv({ timeZone: SAO_PAULO });

      expect(SETS_CSV_COLUMNS.map((column) => column.key)).toEqual([
        'date',
        'session_id',
        'routine',
        'exercise',
        'set_type',
        'weight_kg',
        'reps',
        'duration_s',
        'rir',
        'rpe',
        'note',
      ]);
      expect(csv.startsWith(CSV_BOM)).toBe(true);
      const lines = csv.slice(1).split('\r\n');
      expect(lines[0]).toBe(
        'date,session_id,routine,exercise,set_type,weight_kg,reps,duration_s,rir,rpe,note',
      );
      expect(lines[1]).toBe('2026-10-10,s1,A · Peito,Supino reto,work,42.5,8,,2,8,');
      expect(lines).toHaveLength(4);
      expect(lines[3]).toBe('');
    });

    it('keeps accents, and quotes a note with a comma and quotes (RFC 4180)', async () => {
      const t = setup();
      await seedEverything(t);

      const csv = await t.service.buildSetsCsv({ timeZone: SAO_PAULO });

      expect(csv).toContain('"ficou ""ótimo"", sem dor"');
      expect(csv).toContain('A · Peito');
    });

    it("neutralizes a note that would run as a formula: =2+2 becomes '=2+2", async () => {
      const t = setup();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.put(session('s1', '2026-10-10'));
      await t.trainingDb.sets.bulkPut([
        localSet('x1', 's1', { note: '=2+2' }),
        localSet('x2', 's1', {
          position: 1,
          completedAt: at('2026-10-10', 9, 5),
          note: '@SOMA(A1)',
        }),
      ]);

      const csv = await t.service.buildSetsCsv({ timeZone: SAO_PAULO });

      expect(csv).toContain(",'=2+2\r\n");
      expect(csv).toContain(",'@SOMA(A1)\r\n");
      expect(csv).not.toMatch(/,=2\+2\r\n/);
    });

    it('does not neutralize the numeric columns', async () => {
      const t = setup();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.put(session('s1', '2026-10-10'));
      await t.trainingDb.sets.put(localSet('x1', 's1', { weightKg: 0, reps: 12, rir: 0 }));

      const csv = await t.service.buildSetsCsv({ timeZone: SAO_PAULO });

      expect(csv).toContain(',work,0,12,,0,,');
    });

    it('writes the date of the local day of the given time zone', async () => {
      const t = setup();
      await seedExerciseCatalog(t.trainingDb);
      await t.trainingDb.sessions.put(session('s1', '2026-10-10'));
      await t.trainingDb.sets.put(
        localSet('x1', 's1', { completedAt: Date.UTC(2026, 9, 19, 2, 30) }),
      );

      expect(await t.service.buildSetsCsv({ timeZone: SAO_PAULO })).toContain('2026-10-18,s1');
      expect(await t.service.buildSetsCsv({ timeZone: 'UTC' })).toContain('2026-10-19,s1');
    });

    it('has only the header when there are no sets', async () => {
      const t = setup();

      expect(await t.service.buildSetsCsv({ timeZone: SAO_PAULO })).toBe(
        `${CSV_BOM}date,session_id,routine,exercise,set_type,weight_kg,reps,duration_s,rir,rpe,note\r\n`,
      );
    });
  });

  describe('weekSummaryText', () => {
    const summary = (overrides: Partial<WeekSummary> = {}): WeekSummary => ({
      week: { start: 0, end: 1, startKey: '2026-10-12', endKey: '2026-10-18' },
      sessions: 3,
      workingSets: 54,
      volumeKg: 20673.5,
      volume: {
        total: 54,
        byGroup: { chest: 10, back: 12, legs: 12, shoulders: 8, arms: 12, core: 0 },
        byMuscle: {},
        unclassified: 0,
      },
      records: [
        { exerciseId: 'supino', exerciseName: 'Supino reto', kinds: ['maxWeight', 'oneRepMax'] },
        { exerciseId: 'remada', exerciseName: 'Remada', kinds: ['maxWeight'] },
      ],
      ...overrides,
    });

    it('tells the sessions against the goal, the sets, the volume and the records, in Portuguese', () => {
      const t = setup();

      expect(t.service.weekSummaryText(summary(), 3).split('\n')).toEqual([
        'Treino: resumo da semana de 12/10 a 18/10',
        'Treinos: 3 de 3 (meta)',
        'Séries de trabalho: 54',
        'Volume: 20.673,5 kg',
        'Recordes: Supino reto (carga máxima, 1RM estimado); Remada (carga máxima)',
      ]);
    });

    it('leaves the goal out when there is none, and says so when there is no record', () => {
      const t = setup();

      const lines = t.service.weekSummaryText(summary({ records: [] })).split('\n');

      expect(lines[1]).toBe('Treinos: 3');
      expect(lines[4]).toBe('Recordes: nenhum nesta semana');
    });
  });

  describe('delivery', () => {
    it('downloads the JSON with a dated name', async () => {
      const t = setup();
      await seedEverything(t);

      const name = await t.service.downloadJson({ timeZone: SAO_PAULO });

      expect(name).toBe('uniover-treino-2025-10-09.json');
      expect(t.delivery.downloads).toHaveLength(1);
      expect(t.delivery.downloads[0].filename).toBe(name);
      expect(t.delivery.downloads[0].blob.type).toBe('application/json');
      const parsed = JSON.parse(decode(await bytesOf(t.delivery.downloads[0].blob)));
      expect(parsed.exportVersion).toBe(1);
      expect(Object.keys(parsed.sections)).toContain('sets');
    });

    it('downloads the CSV with the byte order mark as the first bytes of the file', async () => {
      const t = setup();
      await seedEverything(t);

      const name = await t.service.downloadSetsCsv({ timeZone: SAO_PAULO });

      expect(name).toBe('uniover-treino-2025-10-09.csv');
      const { blob } = t.delivery.downloads[0];
      expect(blob.type).toBe('text/csv;charset=utf-8');
      const bytes = await bytesOf(blob);
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(decode(bytes)).toContain('Supino reto');
    });

    it('shares the text of the week summary through the delivery', async () => {
      const t = setup();

      const outcome = await t.service.shareWeekSummary(
        {
          week: { start: 0, end: 1, startKey: '2026-10-12', endKey: '2026-10-18' },
          sessions: 1,
          workingSets: 4,
          volumeKg: 1600,
          volume: {
            total: 4,
            byGroup: { chest: 4, back: 0, legs: 0, shoulders: 0, arms: 0, core: 0 },
            byMuscle: {},
            unclassified: 0,
          },
          records: [],
        },
        3,
      );

      expect(outcome).toBe('shared');
      expect(t.delivery.shares).toHaveLength(1);
      expect(t.delivery.shares[0].title).toBe('Resumo da semana');
      expect(t.delivery.shares[0].text).toContain('Treinos: 1 de 3 (meta)');
      expect(t.delivery.shares[0].text).toContain('Volume: 1.600 kg');
    });
  });
});

describe('export sections without the service', () => {
  it('lets the service work with no section registered at all', async () => {
    TestBed.configureTestingModule({
      providers: [
        ExportService,
        { provide: TRAINING_DB, useValue: createTrainingTestDb() },
        { provide: ExportDelivery, useValue: new FakeDelivery() },
      ],
    });

    const document = await TestBed.inject(ExportService).buildJson();

    expect(document.sections).toEqual({});
  });
});
