import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { FakeRoutineApi, seedCatalog } from '../data/routines/routine-data-test-kit';
import { RoutineApi } from '../data/routines/routine-api';
import { RoutineRepository } from '../data/routines/routine-repository';
import { catalog, eventually, item, saveRoutine, setupScreen } from '../shell/screen-test-kit';
import { RoutinesListPage } from './routines-list.page';

describe('RoutinesListPage', () => {
  async function open(templateDescription?: string, templateId = 'duplo') {
    const api = new FakeRoutineApi();
    if (templateDescription !== undefined) {
      api.dto = {
        items: api.dto.items.map((template) => ({
          ...template,
          id: templateId,
          description: templateDescription,
        })),
      };
    }
    const kit = await setupScreen(
      [{ path: 'treino/rotinas', component: RoutinesListPage }],
      [{ provide: RoutineApi, useValue: api }],
    );
    await kit.trainingDb.exercises.bulkPut(catalog());
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino/rotinas', RoutinesListPage);
    const el = harness.routeNativeElement as HTMLElement;
    return { ...kit, api, fixture: harness.fixture, el };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const rows = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLAnchorElement>('.list .ui-row'));
  const button = (el: HTMLElement, label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((node) =>
      node.textContent?.includes(label),
    )!;

  it('says there is no routine yet, and offers to create the first', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(text(el)).toContain('Sem rotinas ainda'));
    expect(el.querySelector<HTMLAnchorElement>('.actions a')?.getAttribute('href')).toBe(
      '/treino/rotinas/nova',
    );
  });

  it('lists the routines in the order of the sequence, each with its letter and a short summary', async () => {
    const { fixture, el } = await open();
    await saveRoutine('Treino A', [item('a1', 'supino-reto', 0), item('a2', 'agachamento', 1)]);
    await saveRoutine('Treino B', [item('b1', 'elevacao', 0, { targetSets: 4 })]);
    await eventually(fixture, () => expect(rows(el)).toHaveLength(2));
    expect(rows(el).map((row) => row.querySelector('.ui-tile')?.textContent?.trim())).toEqual([
      'A',
      'B',
    ]);
    expect(rows(el).map((row) => row.querySelector('.ui-row-title')?.textContent?.trim())).toEqual([
      'Treino A',
      'Treino B',
    ]);
    expect(rows(el)[0].querySelector('.ui-row-sub')?.textContent).toMatch(
      /^2 exercícios · 6 séries · cerca de \d+ min$/,
    );
    expect(rows(el)[1].querySelector('.ui-row-sub')?.textContent).toMatch(
      /^1 exercício · 4 séries/,
    );
    expect(el.querySelector('.count')?.textContent).toBe('2 rotinas · na ordem da sequência');
  });

  it('marks the next routine of the sequence, and the one left out of it', async () => {
    const { fixture, el } = await open();
    await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
    await saveRoutine('Treino B', [item('b1', 'agachamento', 0)], { active: false });
    await eventually(fixture, () => expect(rows(el)).toHaveLength(2));
    expect(rows(el)[0].querySelector('.eyebrow')?.textContent?.trim()).toBe('próxima');
    expect(rows(el)[1].querySelector('.eyebrow')?.textContent?.trim()).toBe('fora da sequência');
  });

  it('opens a routine in the editor', async () => {
    const { fixture, el } = await open();
    const routine = await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
    await eventually(fixture, () => expect(rows(el)).toHaveLength(1));
    expect(rows(el)[0].getAttribute('href')).toBe(`/treino/rotinas/${routine.id}`);
  });

  describe('ready-made templates', () => {
    it('labels the rejected historical A/B as partial and creates it inactive only after preview', async () => {
      const description =
        'Histórico · rejeitado pelo dono · rascunho parcial. Não é recomendação e nunca será ativado automaticamente.\n\nA alternância semanal e o encaixe em 45–60 minutos não foram confirmados.';
      const { api, fixture, el, trainingDb } = await open();
      const source = api.dto.items[0];
      api.dto = {
        items: [
          {
            ...source,
            id: 'historical-ab',
            name: 'A/B histórico rejeitado',
            description,
            routines: source.routines.map((routine, index) => ({
              ...routine,
              name: index === 0 ? 'A · Histórico rejeitado' : 'B · Histórico rejeitado',
            })),
          },
        ],
      };
      await seedCatalog(trainingDb, ['supino', 'crucifixo', 'rosca', 'triceps']);
      await eventually(fixture, () => expect(button(el, 'Usar modelo')).toBeDefined());
      button(el, 'Usar modelo').click();
      await eventually(fixture, () => expect(el.querySelector('dialog .ui-row')).not.toBeNull());

      const row = el.querySelector<HTMLButtonElement>('dialog .ui-row')!;
      expect(row.textContent).toContain('Histórico · rejeitado pelo dono');
      expect(el.querySelector('dialog .create-draft')).toBeNull();
      row.click();
      await eventually(fixture, () => expect(text(el)).toContain('não foram confirmados'));
      button(el, 'Criar este rascunho parcial').click();

      await eventually(fixture, () => expect(rows(el)).toHaveLength(2));
      expect(
        rows(el).map((routine) => routine.querySelector('.ui-row-title')?.textContent?.trim()),
      ).toEqual(['A · Histórico rejeitado', 'B · Histórico rejeitado']);
      await eventually(fixture, () =>
        expect(text(el)).toContain(
          'Estas rotinas históricas ficaram inativas e não são uma recomendação.',
        ),
      );
      expect(text(el)).not.toContain('ative quando estiverem completas');
    });

    it('requires previewing a partial program before choosing it', async () => {
      const { fixture, el, trainingDb } = await open(
        'Rascunho parcial · opção 3 · cinco sessões.\n\nRosca de terça omitida: confira antes de criar.',
        'ab-reajustado',
      );
      await seedCatalog(trainingDb, ['supino', 'crucifixo', 'rosca', 'triceps']);
      await eventually(fixture, () => expect(button(el, 'Usar modelo')).toBeDefined());
      button(el, 'Usar modelo').click();
      await eventually(fixture, () => expect(el.querySelector('dialog .ui-row')).not.toBeNull());

      const row = el.querySelector<HTMLButtonElement>('dialog .ui-row')!;
      expect(row.textContent).toContain('Rascunho parcial · opção 3 · cinco sessões.');
      expect(el.querySelector('dialog .create-draft')).toBeNull();
      row.click();
      await eventually(fixture, () => expect(text(el)).toContain('Rosca de terça omitida'));
      const create = button(el, 'Escolher este programa');
      expect(create).toBeDefined();
      create.click();
      await eventually(fixture, () =>
        expect(text(el)).toContain('Programa Duplo escolhido. Hoje abre no treino do dia.'),
      );
      expect(text(el)).not.toContain('ficaram inativas');
    });

    it('chooses the program: the routines are created active on the device, and the choice is queued', async () => {
      const { fixture, el, trainingDb } = await open();
      await seedCatalog(trainingDb, ['supino', 'crucifixo', 'rosca', 'triceps']);
      await eventually(fixture, () => expect(button(el, 'Usar modelo')).toBeDefined());
      button(el, 'Usar modelo').click();
      await eventually(fixture, () => expect(el.querySelector('dialog .ui-row')).not.toBeNull());
      const row = el.querySelector<HTMLButtonElement>('dialog .ui-row')!;
      expect(row.textContent).toContain('Duplo');
      expect(row.textContent).toContain('2 treinos');
      row.click();
      await eventually(fixture, () => expect(rows(el)).toHaveLength(2));
      await eventually(fixture, () =>
        expect(text(el)).toContain('Programa Duplo escolhido. Hoje abre no treino do dia.'),
      );
      await eventually(fixture, () => expect(el.querySelector('dialog')).toBeNull());
      expect(rows(el).map((r) => r.querySelector('.ui-row-title')?.textContent?.trim())).toEqual([
        'A · Peito',
        'B · Braços',
      ]);
      expect(await TestBed.inject(RoutineRepository).activeProgramId()).toBe('duplo');
      // Duas fichas e a escolha do programa esperam na fila de escrita, como qualquer gravação.
      expect(await TestBed.inject(OfflineQueue).items()).toHaveLength(3);
    });

    it('says how many exercises of a historical template were left out because the catalog lacks them', async () => {
      const { fixture, el, trainingDb } = await open('Histórico.', 'historical-ab');
      await seedCatalog(trainingDb, ['supino', 'crucifixo', 'rosca']);
      await eventually(fixture, () => expect(button(el, 'Usar modelo')).toBeDefined());
      button(el, 'Usar modelo').click();
      await eventually(fixture, () => expect(el.querySelector('dialog .ui-row')).not.toBeNull());
      el.querySelector<HTMLButtonElement>('dialog .ui-row')!.click();
      await eventually(fixture, () =>
        expect(text(el)).toContain('1 exercício do modelo não está no seu catálogo'),
      );
      expect(el.querySelector('.ui-notice.warn')).not.toBeNull();
    });

    it('stays shut without network, and says why', async () => {
      const { fixture, el } = await open();
      TestBed.inject(ConnectivityService).online.set(false);
      await eventually(fixture, () =>
        expect(text(el)).toContain('Os modelos prontos precisam de rede'),
      );
      expect(button(el, 'Usar modelo').disabled).toBe(true);
      // Nova rotina continua valendo sem rede.
      expect(el.querySelector('.actions a')?.getAttribute('href')).toBe('/treino/rotinas/nova');
    });

    it('says when the templates cannot be loaded', async () => {
      const { api, fixture, el } = await open();
      api.failing = true;
      await eventually(fixture, () => expect(button(el, 'Usar modelo')).toBeDefined());
      button(el, 'Usar modelo').click();
      await eventually(fixture, () =>
        expect(text(el)).toContain('Não deu para carregar os modelos'),
      );
      expect(el.querySelector('dialog .ui-row')).toBeNull();
    });

    it('reads the routines through the repository only', async () => {
      const { fixture, el } = await open();
      const list = vi.spyOn(TestBed.inject(RoutineRepository), 'listAll');
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      await eventually(fixture, () => expect(rows(el)).toHaveLength(1));
      expect(list).toHaveBeenCalled();
    });
  });
});
