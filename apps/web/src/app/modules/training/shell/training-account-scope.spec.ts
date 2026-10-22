import { DB_CLOSE_GRACE_MS } from '../../../core/session/db-close';
import { TrainingSync } from '../data/sync/training-sync';
import { localExercise } from '../data/sync/training-test-kit';
import { TRAINING_ROUTES } from '../training.routes';
import { catalog, eventually, setupScreen } from './screen-test-kit';

const routes = [{ path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES }];

describe('TrainingAccountScope', () => {
  afterEach(() => vi.restoreAllMocks());

  async function open(url = '/treino/exercicios') {
    // Com a folga de verdade antes de fechar o banco de uma conta que saiu: é o que protege as leituras ainda em andamento.
    const kit = await setupScreen(routes, [{ provide: DB_CLOSE_GRACE_MS, useValue: 1500 }]);
    return { ...kit, url };
  }

  async function show(kit: Awaited<ReturnType<typeof open>>) {
    const harness = await kit.harness();
    await harness.navigateByUrl(kit.url);
    return { harness, fixture: harness.fixture, el: harness.routeNativeElement as HTMLElement };
  }

  const names = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.list .name')).map((node) => node.textContent?.trim());
  const entering = (el: HTMLElement) => el.textContent?.includes('Confirmando a sua conta');

  it('shows the module only for the account in use, with its own database', async () => {
    const kit = await open();
    kit.account.signInAs('conta-a');
    await kit.trainingDbOf('conta-a').exercises.bulkPut(catalog());
    await kit
      .trainingDbOf('conta-b')
      .exercises.bulkPut([localExercise('so-do-b', { name: 'Remada B' })]);

    const { fixture, el } = await show(kit);

    await eventually(fixture, () => expect(names(el)).toHaveLength(5));
    expect(names(el)).not.toContain('Remada B');
    expect(entering(el)).toBe(false);
  });

  it('recreates everything below when the account changes: B sees nothing of A, and A sees its own again', async () => {
    const start = vi.spyOn(TrainingSync.prototype, 'start');
    const kit = await open();
    kit.account.signInAs('conta-a');
    await kit.trainingDbOf('conta-a').exercises.bulkPut(catalog());
    const { fixture, el } = await show(kit);
    await eventually(fixture, () => expect(names(el)).toHaveLength(5));
    const pageOfA = el.querySelector('app-training-page');
    const startsBefore = start.mock.calls.length;

    // B entra neste navegador, sem recarregar a página.
    kit.account.signInAs('conta-b');
    await eventually(fixture, () =>
      expect(el.querySelector('app-training-page')).not.toBe(pageOfA),
    );
    await eventually(fixture, () => expect(el.querySelector('app-training-page')).not.toBeNull());

    // A tela continua na rota em que estava (a recriada reativa a página da rota), vazia: nada de A.
    expect(el.querySelector('app-exercise-library-page')).not.toBeNull();
    expect(names(el)).toEqual([]);
    // O puxador, os repositórios e os estados são outros (o do escopo anterior ficou para trás).
    expect(start.mock.calls.length).toBeGreaterThan(startsBefore);
    const instances = start.mock.contexts.slice(startsBefore);
    expect(new Set(instances).size).toBe(instances.length);

    // A volta: o que é dela está no banco dela.
    kit.account.signInAs('conta-a');
    await eventually(fixture, () => expect(names(el)).toHaveLength(5));
  });

  describe('Hoje', () => {
    const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';

    it('shows the open workout and the sets waiting to be sent only to the account they belong to', async () => {
      const kit = await open('/treino');
      const at = 1_760_000_000_000;
      // A tem um treino aberto e uma série ainda não enviada, no banco e na fila dela.
      const dbOfA = kit.trainingDbOf('conta-a');
      await dbOfA.sessions.put({
        id: 'treino-aberto',
        routineId: null,
        startedAt: at,
        finishedAt: null,
        note: '',
        feeling: null,
        deviceId: 'aparelho-de-a',
        updatedAt: at,
        clientUpdatedAt: at,
        deletedAt: null,
      });
      await dbOfA.meta.bulkPut([
        { key: 'deviceId', value: 'aparelho-de-a' },
        { key: 'activeSessionId', value: 'treino-aberto' },
      ]);
      await kit.dbOf('conta-a').outbox.add({
        id: '0199aaaa-0000-7000-8000-000000000001',
        method: 'PUT',
        url: '/api/v1/training/sessions/treino-aberto/sets/serie-1',
        body: {},
        module: 'training',
        createdAt: 1,
        attempts: 0,
        nextAttemptAt: 0,
        status: 'pending',
        lastError: null,
        revision: 0,
      });
      kit.account.signInAs('conta-a');
      const { fixture, el } = await show(kit);
      await eventually(fixture, () => expect(text(el)).toContain('Treino em andamento'));
      await eventually(fixture, () => expect(text(el)).toContain('1 ainda não sincronizado'));

      // B entra: a tela Hoje é a dele, sem o treino aberto de A nem o aviso do que espera envio.
      kit.account.signInAs('conta-b');
      await eventually(fixture, () => {
        expect(el.querySelector('app-training-today-page')).not.toBeNull();
        expect(text(el)).not.toContain('Treino em andamento');
        expect(text(el)).not.toContain('Continuar treino');
        expect(text(el)).not.toContain('ainda não sincronizado');
      });

      // A volta e tudo o que era dele está como estava.
      kit.account.signInAs('conta-a');
      await eventually(fixture, () => expect(text(el)).toContain('Treino em andamento'));
      await eventually(fixture, () => expect(text(el)).toContain('1 ainda não sincronizado'));
    });
  });

  describe('without a known account', () => {
    it('opens no database and shows only that the account is being confirmed', async () => {
      const kit = await open();
      kit.account.signInAs(null);

      const { fixture, el } = await show(kit);

      fixture.detectChanges();
      expect(entering(el)).toBe(true);
      expect(el.querySelector('app-training-page')).toBeNull();
      expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe(
        'Confirmando a sua conta…',
      );
      expect((await kit.dbOptions.indexedDB.databases()).map((db) => db.name)).toEqual([]);
    });

    it('shows the screens as soon as the account is known, and the database of nobody was never created', async () => {
      const kit = await open();
      kit.account.signInAs(null);
      const { fixture, el } = await show(kit);
      fixture.detectChanges();
      expect(el.querySelector('app-training-page')).toBeNull();

      kit.account.signInAs('conta-a');
      await eventually(fixture, () => expect(el.querySelector('app-training-page')).not.toBeNull());

      expect(entering(el)).toBe(false);
      expect((await kit.dbOptions.indexedDB.databases()).map((db) => db.name)).not.toContain(
        'uniover-training',
      );
    });

    it('goes back to that state when the account leaves, with the screens of the account gone', async () => {
      const kit = await open();
      kit.account.signInAs('conta-a');
      const { fixture, el } = await show(kit);
      await eventually(fixture, () => expect(el.querySelector('app-training-page')).not.toBeNull());

      kit.account.signInAs(null);
      await eventually(fixture, () => expect(entering(el)).toBe(true));

      expect(el.querySelector('app-training-page')).toBeNull();
    });
  });

  describe('the old database, from before there was one per account', () => {
    it('is adopted before the screens appear, and they show what was adopted', async () => {
      const kit = await open();
      const legacy = kit.trainingLegacyDb();
      await legacy.exercises.bulkPut(catalog());
      legacy.close();
      kit.account.legacyOwner = 'conta-a';
      kit.account.signInAs('conta-a');

      const { fixture, el } = await show(kit);
      // Antes de a cópia terminar, só o aviso (as telas nunca leem um banco ainda vazio).
      expect(el.querySelector('app-training-page')).toBeNull();

      await eventually(fixture, () => expect(names(el)).toHaveLength(5));
      expect(entering(el)).toBe(false);
    });

    it('is not shown to another account that opens the module', async () => {
      const kit = await open();
      const legacy = kit.trainingLegacyDb();
      await legacy.exercises.bulkPut(catalog());
      legacy.close();
      kit.account.legacyOwner = 'conta-a';
      kit.account.signInAs('conta-b');

      const { fixture, el } = await show(kit);

      await eventually(fixture, () => expect(el.querySelector('app-training-page')).not.toBeNull());
      expect(names(el)).toEqual([]);
    });
  });
});
