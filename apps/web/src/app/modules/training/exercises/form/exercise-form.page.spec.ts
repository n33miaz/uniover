import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { localExercise } from '../../data/sync/training-test-kit';
import { catalog, eventually, setupScreen } from '../../shell/screen-test-kit';
import { ExerciseFormPage } from './exercise-form.page';

describe('ExerciseFormPage', () => {
  async function open(url: string) {
    const kit = await setupScreen([
      { path: 'treino/exercicios/novo', component: ExerciseFormPage },
      { path: 'treino/exercicios/:id/editar', component: ExerciseFormPage },
      { path: '**', children: [] },
    ]);
    await kit.trainingDb.exercises.bulkPut([
      ...catalog(),
      localExercise('meu', {
        source: 'own',
        slug: 'meu',
        name: 'Remada na máquina',
        primaryMuscles: ['middle_back'],
        equipment: 'machine',
        recordType: 'reps_only',
        instructions: ['Puxe.', 'Solte.'],
      }),
    ]);
    const harness = await kit.harness();
    await harness.navigateByUrl(url, ExerciseFormPage);
    const el = harness.routeNativeElement as HTMLElement;
    return { ...kit, fixture: harness.fixture, el, router: TestBed.inject(Router) };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const field = <T extends HTMLElement>(el: HTMLElement, selector: string) =>
    el.querySelector<T>(selector)!;
  const button = (el: HTMLElement, label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (node) => node.textContent?.trim() === label,
    )!;

  const MUSCLES: Record<string, string> = {
    chest: 'Peitoral',
    middle_back: 'Meio das costas',
    abdominals: 'Abdômen',
  };

  /** Abre a lista de músculos por grupo e toca no músculo. */
  function chooseMuscle(fixture: { detectChanges(): void }, el: HTMLElement, id: string) {
    field<HTMLButtonElement>(el, '#exercise-muscle').click();
    fixture.detectChanges();
    const row = Array.from(el.querySelectorAll<HTMLButtonElement>('dialog .ui-row')).find(
      (node) => node.textContent?.trim() === MUSCLES[id],
    )!;
    row.click();
    fixture.detectChanges();
  }

  function chooseEquipment(fixture: { detectChanges(): void }, el: HTMLElement, label: string) {
    const chip = Array.from(
      el.querySelectorAll<HTMLButtonElement>('app-training-chips .chip'),
    ).find((node) => node.textContent?.trim() === label)!;
    chip.click();
    fixture.detectChanges();
  }

  function fill(fixture: { detectChanges(): void }, el: HTMLElement, name: string, muscle: string) {
    const input = field<HTMLInputElement>(el, '#exercise-name');
    input.value = name;
    input.dispatchEvent(new Event('input'));
    if (muscle) chooseMuscle(fixture, el, muscle);
  }

  describe('new exercise', () => {
    it('starts empty, with the muscles listed by group', async () => {
      const { fixture, el } = await open('/treino/exercicios/novo');
      fixture.detectChanges();
      expect(el.querySelector('h2')?.textContent).toContain('Novo Exercício');
      expect(field<HTMLInputElement>(el, '#exercise-name').value).toBe('');
      // O músculo se escolhe numa lista por grupo (uma folha), não no seletor nativo.
      expect(field(el, '#exercise-muscle').textContent).toContain('Escolha o músculo');
      field<HTMLButtonElement>(el, '#exercise-muscle').click();
      fixture.detectChanges();
      const groups = Array.from(el.querySelectorAll('dialog .muscle-group h3')).map((h) =>
        h.textContent?.trim(),
      );
      expect(groups).toEqual(['Peito', 'Costas', 'Pernas', 'Ombros', 'Braços', 'Abdômen']);
      const chest = el.querySelector('dialog .muscle-group')!;
      expect(
        Array.from(chest.querySelectorAll('.ui-row')).map((row) => row.textContent?.trim()),
      ).toEqual(['Peitoral']);
      // O equipamento são chips de escolha única, com a barra marcada de partida.
      const chips = Array.from(el.querySelectorAll<HTMLButtonElement>('app-training-chips .chip'));
      expect(chips.map((chip) => chip.textContent?.trim())).toEqual([
        'Barra',
        'Halteres',
        'Máquina',
        'Polia',
        'Peso do corpo',
        'Kettlebell',
        'Elástico',
        'Cardio',
        'Outro',
      ]);
      expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual([
        'true',
        'false',
        'false',
        'false',
        'false',
        'false',
        'false',
        'false',
        'false',
      ]);
    });

    it('keeps Save off while nothing changed, and does not scold an untouched form', async () => {
      const { fixture, el } = await open('/treino/exercicios/novo');
      fixture.detectChanges();
      expect(button(el, 'Salvar Exercício').disabled).toBe(true);
      expect(text(el)).not.toContain('Dê um nome ao exercício.');
      expect(text(el)).not.toContain('Escolha o músculo principal.');
    });

    it('keeps Save off and says what is missing, and saves nothing', async () => {
      const { fixture, el } = await open('/treino/exercicios/novo');
      const input = field<HTMLInputElement>(el, '#exercise-name');
      input.value = 'Remada articulada';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      // O nome está certo, falta o músculo: o botão fica desligado e o aviso diz o motivo.
      expect(button(el, 'Salvar Exercício').disabled).toBe(true);
      expect(text(el)).toContain('Escolha o músculo principal.');
      expect(text(el)).not.toContain('Dê um nome ao exercício.');
      // Só o músculo escolhido, sem nome: o aviso do nome aparece e o botão continua desligado.
      input.value = '   ';
      input.dispatchEvent(new Event('input'));
      chooseMuscle(fixture, el, 'chest');
      expect(text(el)).toContain('Dê um nome ao exercício.');
      expect(field(el, '#exercise-name').getAttribute('aria-invalid')).toBe('true');
      expect(button(el, 'Salvar Exercício').disabled).toBe(true);
      expect(await TestBed.inject(OfflineQueue).items()).toHaveLength(0);
    });

    it('turns Save on once the name and the muscle are there', async () => {
      const { fixture, el } = await open('/treino/exercicios/novo');
      fill(fixture, el, 'Remada articulada', 'middle_back');
      expect(button(el, 'Salvar Exercício').disabled).toBe(false);
    });

    it('keeps Save in the fixed bar at the bottom, where the notices also live', async () => {
      const { fixture, el } = await open('/treino/exercicios/novo');
      fixture.detectChanges();
      const bar = field(el, '.ui-action-bar');
      expect(bar.contains(button(el, 'Salvar Exercício'))).toBe(true);
      expect(bar.contains(button(el, 'Cancelar'))).toBe(true);
      expect(field(el, 'form').classList.contains('ui-has-action-bar')).toBe(true);
    });

    it('saves as your own exercise, queues the write once, and opens the sheet', async () => {
      const { fixture, el, router, trainingDb } = await open('/treino/exercicios/novo');
      fill(fixture, el, '  Remada articulada  ', 'middle_back');
      chooseEquipment(fixture, el, 'Máquina');
      button(el, 'Salvar Exercício').click();
      await vi.waitFor(() => expect(router.url).toMatch(/^\/treino\/exercicios\/[0-9a-f-]{36}$/), {
        timeout: 3000,
      });
      const saved = (await trainingDb.exercises.toArray()).find(
        (row) => row.source === 'own' && row.name === 'Remada articulada',
      );
      expect(saved).toMatchObject({
        primaryMuscles: ['middle_back'],
        equipment: 'machine',
        recordType: 'weight_reps',
        instructions: [],
        deletedAt: null,
      });
      const queue = await TestBed.inject(OfflineQueue).items();
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ method: 'PUT', body: { name: 'Remada articulada' } });
      expect(router.url).toContain(saved!.id);
    });

    it('saves the steps one per line, and the record type that was chosen', async () => {
      const { fixture, el, router, trainingDb } = await open('/treino/exercicios/novo');
      fill(fixture, el, 'Prancha lateral', 'abdominals');
      expect(el.querySelector('#exercise-steps')).toBeNull();
      button(el, 'Instruções (opcional)').click();
      fixture.detectChanges();
      const steps = field<HTMLTextAreaElement>(el, '#exercise-steps-text');
      steps.value = 'Apoie o cotovelo.\n\nSuba o quadril.';
      steps.dispatchEvent(new Event('input'));
      const time = Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find(
        (radio) => radio.value === 'time',
      )!;
      time.checked = true;
      time.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      button(el, 'Salvar Exercício').click();
      await vi.waitFor(() => expect(router.url).toMatch(/\/treino\/exercicios\/[0-9a-f-]{36}$/), {
        timeout: 3000,
      });
      const saved = (await trainingDb.exercises.toArray()).find(
        (row) => row.name === 'Prancha lateral',
      );
      expect(saved).toMatchObject({
        recordType: 'time',
        instructions: ['Apoie o cotovelo.', 'Suba o quadril.'],
      });
    });

    it('warns about a repeated name without blocking the save', async () => {
      const { fixture, el, router } = await open('/treino/exercicios/novo');
      fill(fixture, el, 'supino RETO com barra', 'chest');
      await eventually(fixture, () =>
        expect(text(el)).toContain('Já existe um exercício com este nome'),
      );
      expect(el.querySelector('.ui-notice.warn')).not.toBeNull();
      button(el, 'Salvar Exercício').click();
      await vi.waitFor(() => expect(router.url).toMatch(/\/treino\/exercicios\/[0-9a-f-]{36}$/), {
        timeout: 3000,
      });
    });

    it('comes with the suggested name from a search with no result', async () => {
      const { fixture, el } = await open('/treino/exercicios/novo?nome=Remada%20cavalinho');
      fixture.detectChanges();
      expect(field<HTMLInputElement>(el, '#exercise-name').value).toBe('Remada cavalinho');
      // O nome sugerido não é alteração de quem digita: sair não pede confirmação.
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      field<HTMLButtonElement>(el, '.actions button').click();
      expect(el.querySelector('.leave')).toBeNull();
      expect(navigate).toHaveBeenCalledWith('/treino/exercicios', { replaceUrl: true });
    });

    it('does not keep the exercise when the device has no room for the queue', async () => {
      const { fixture, el, trainingDb } = await open('/treino/exercicios/novo');
      vi.spyOn(TestBed.inject(OfflineQueue), 'enqueue').mockRejectedValue(
        new QueueStorageFullError(),
      );
      fill(fixture, el, 'Remada articulada', 'middle_back');
      button(el, 'Salvar Exercício').click();
      await eventually(fixture, () => expect(text(el)).toContain('Sem espaço no aparelho'));
      expect(
        (await trainingDb.exercises.toArray()).some((row) => row.name === 'Remada articulada'),
      ).toBe(false);
    });
  });

  describe('leaving', () => {
    it('leaves at once when nothing was changed', async () => {
      const { el, router } = await open('/treino/exercicios/novo');
      const navigate = vi.spyOn(router, 'navigateByUrl');
      button(el, 'Cancelar').click();
      expect(el.querySelector('.leave')).toBeNull();
      expect(navigate).toHaveBeenCalledWith('/treino/exercicios', { replaceUrl: true });
    });

    it('asks first when something was typed, and "Continuar Editando" keeps the form', async () => {
      const { fixture, el, router } = await open('/treino/exercicios/novo');
      fill(fixture, el, 'Algo', '');
      const navigate = vi.spyOn(router, 'navigateByUrl');
      button(el, 'Cancelar').click();
      fixture.detectChanges();
      expect(text(el)).toContain('Sair sem salvar?');
      expect(navigate).not.toHaveBeenCalled();
      button(el, 'Continuar Editando').click();
      fixture.detectChanges();
      expect(el.querySelector('.leave')).toBeNull();
      expect(field<HTMLInputElement>(el, '#exercise-name').value).toBe('Algo');
    });

    it('leaves without saving after the confirmation', async () => {
      const { fixture, el, router, trainingDb } = await open('/treino/exercicios/novo');
      fill(fixture, el, 'Algo', 'chest');
      const navigate = vi.spyOn(router, 'navigateByUrl');
      button(el, 'Cancelar').click();
      fixture.detectChanges();
      expect(text(el)).toContain('Sair sem salvar?');
      button(el, 'Sair sem Salvar').click();
      expect(navigate).toHaveBeenCalledWith('/treino/exercicios', { replaceUrl: true });
      expect((await trainingDb.exercises.toArray()).some((row) => row.name === 'Algo')).toBe(false);
    });
  });

  describe('editing', () => {
    it('opens with what the exercise has, steps included', async () => {
      const { fixture, el } = await open('/treino/exercicios/meu/editar');
      await eventually(fixture, () =>
        expect(field<HTMLInputElement>(el, '#exercise-name').value).toBe('Remada na máquina'),
      );
      expect(el.querySelector('h2')?.textContent).toContain('Editar Exercício');
      expect(field(el, '#exercise-muscle').textContent).toContain('Meio das costas');
      const pressed = Array.from(
        el.querySelectorAll<HTMLButtonElement>('app-training-chips .chip[aria-pressed="true"]'),
      );
      expect(pressed.map((chip) => chip.textContent?.trim())).toEqual(['Máquina']);
      expect(field<HTMLTextAreaElement>(el, '#exercise-steps-text').value).toBe('Puxe.\nSolte.');
      expect(
        Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find(
          (r) => r.checked,
        )?.value,
      ).toBe('reps_only');
    });

    it('saves over the same exercise and queues one write', async () => {
      const { fixture, el, router, trainingDb } = await open('/treino/exercicios/meu/editar');
      await eventually(fixture, () =>
        expect(field<HTMLInputElement>(el, '#exercise-name').value).not.toBe(''),
      );
      const input = field<HTMLInputElement>(el, '#exercise-name');
      expect(button(el, 'Salvar Exercício').disabled).toBe(true);
      input.value = 'Remada na máquina articulada';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(button(el, 'Salvar Exercício').disabled).toBe(false);
      button(el, 'Salvar Exercício').click();
      await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios/meu'), { timeout: 3000 });
      expect((await trainingDb.exercises.get('meu'))?.name).toBe('Remada na máquina articulada');
      expect(await TestBed.inject(OfflineQueue).items()).toHaveLength(1);
    });

    it('does not let a catalog exercise be edited', async () => {
      const { fixture, el } = await open('/treino/exercicios/supino-reto/editar');
      await eventually(fixture, () => expect(text(el)).toContain('não é um exercício seu'));
      expect(el.querySelector('form')).toBeNull();
    });
  });
});
