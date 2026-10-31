import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CatalogRepository } from '../../data/catalog/catalog-repository';
import { CatalogWriter } from '../../data/catalog/catalog-writer';
import {
  EQUIPMENT_IDS,
  MUSCLE_GROUP_IDS,
  RECORD_TYPES,
  equipmentLabel,
  muscleGroupLabel,
  muscleLabel,
  musclesOfGroup,
  recordTypeLabel,
} from '../../domain/taxonomy';
import { BackNavigation } from '../../shell/back-navigation';
import { ChipOption, TrainingChips } from '../../shell/training-chips';
import { TrainingGlyph } from '../../shell/training-glyph';
import { TrainingHeaderActions } from '../../shell/training-header-actions';
import { TrainingSheet } from '../../shell/training-sheet';
import {
  EMPTY_EXERCISE_FORM,
  ExerciseForm,
  ExerciseFormIssue,
  isFormDirty,
  parseSteps,
  sameExerciseName,
  validateExerciseForm,
} from './exercise-form';
import { TrainingFormSkeleton } from '../../shell/training-form-skeleton';

/**
 * Novo exercício (e edição de um exercício próprio): nome, músculo principal, equipamento, tipo de registro e
 * instruções (opcionais, atrás de um toque). Salva pelo `CatalogWriter` (grava no aparelho e enfileira uma vez). A
 * lista de músculos é a da taxonomia, agrupada por grupo. Sair com alterações pede confirmação ali mesmo.
 */
@Component({
  selector: 'app-exercise-form-page',
  imports: [TrainingGlyph, TrainingChips, TrainingSheet, TrainingFormSkeleton],
  templateUrl: './exercise-form.page.html',
  styleUrl: './exercise-form.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseFormPage {
  protected readonly loadingLabel = $localize`:@@training.form.loading:Carregando o exercício…`;
  private readonly catalog = inject(CatalogRepository);
  private readonly writer = inject(CatalogWriter);
  private readonly back = inject(BackNavigation);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly headerActions = inject(TrainingHeaderActions);

  /** Id do exercício que está sendo editado; vazio em "Novo exercício". */
  protected readonly editingId = this.route.snapshot.paramMap.get('id') ?? '';
  protected readonly editing = this.editingId !== '';

  protected readonly form = signal<ExerciseForm>(EMPTY_EXERCISE_FORM);
  private readonly initial = signal<ExerciseForm>(EMPTY_EXERCISE_FORM);
  /** `loading`: lendo o exercício a editar · `missing`: não existe, foi apagado ou não é próprio · `ready`. */
  protected readonly state = signal<'loading' | 'missing' | 'ready'>(
    this.editing ? 'loading' : 'ready',
  );

  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly confirmingLeave = signal(false);
  protected readonly stepsOpen = signal(false);
  protected readonly duplicate = signal(false);

  protected readonly dirty = computed(() => isFormDirty(this.initial(), this.form()));
  protected readonly issues = computed<readonly ExerciseFormIssue[]>(() =>
    this.submitted() ? validateExerciseForm(this.form()) : [],
  );
  protected readonly nameError = computed(() => {
    const issues = this.issues();
    if (issues.includes('name-missing'))
      return $localize`:@@training.form.name-missing:Dê um nome ao exercício.`;
    if (issues.includes('name-too-long'))
      return $localize`:@@training.form.name-long:O nome pode ter até 120 caracteres.`;
    return '';
  });
  protected readonly muscleError = computed(() =>
    this.issues().includes('muscle-missing')
      ? $localize`:@@training.form.muscle-missing:Escolha o músculo principal.`
      : '',
  );
  protected readonly stepsError = computed(() =>
    this.issues().includes('steps-invalid')
      ? $localize`:@@training.form.steps-invalid:Use até 20 passos de até 500 caracteres, um por linha.`
      : '',
  );

  protected readonly muscleGroups = MUSCLE_GROUP_IDS.map((id) => ({
    id,
    label: muscleGroupLabel(id),
    muscles: musclesOfGroup(id).map((muscle) => ({ id: muscle, label: muscleLabel(muscle) })),
  }));
  protected readonly equipments: readonly ChipOption[] = EQUIPMENT_IDS.map((id) => ({
    id,
    label: equipmentLabel(id),
  }));
  protected readonly recordTypes = RECORD_TYPES.map((id) => ({ id, label: recordTypeLabel(id) }));

  protected readonly title = this.editing
    ? $localize`:@@training.form.title-edit:Editar Exercício`
    : $localize`:@@training.form.title-new:Novo Exercício`;
  protected readonly muscleOpen = signal(false);
  protected readonly muscleHeading = $localize`:@@training.form.muscle-heading:Músculo Principal`;
  protected readonly cancelLabel = $localize`:@@training.form.muscle-cancel:Cancelar`;
  protected readonly equipmentGroupLabel = $localize`:@@training.form.equipment-group:Equipamento`;
  protected readonly muscleShown = computed(() => {
    const muscle = this.form().muscle;
    return muscle
      ? muscleLabel(muscle)
      : $localize`:@@training.form.muscle-choose:Escolha o músculo`;
  });
  // O nome acessível leva o texto que está à vista (o músculo escolhido ou o convite a escolher): o rótulo visível precisa estar nele.
  protected readonly muscleButtonLabel = computed(() => {
    const shown = this.muscleShown();
    return $localize`:@@training.form.muscle-button:Músculo principal: ${shown}:shown:`;
  });
  protected readonly stepsCount = computed(() => parseSteps(this.form().steps).length);

  private duplicateTicket = 0;

  constructor() {
    inject(DestroyRef).onDestroy(this.headerActions.registerBack(() => this.cancel()));
    if (this.editing) void this.loadExisting();
    else {
      // "Criar “x”", da busca sem resultado, chega com o nome sugerido.
      const suggested = (this.route.snapshot.queryParamMap.get('nome') ?? '').trim().slice(0, 120);
      if (suggested !== '') this.start({ ...EMPTY_EXERCISE_FORM, name: suggested });
    }

    // O aviso de nome repetido não bloqueia: só avisa, e quem decide é quem salva.
    // Relê também quando o catálogo chega ou muda (a primeira passada do servidor pode acabar depois de a pessoa digitar).
    effect(() => {
      const name = this.form().name;
      this.catalog.revision();
      untracked(() => void this.checkDuplicate(name));
    });
  }

  protected setName(value: string): void {
    this.form.update((form) => ({ ...form, name: value }));
  }

  protected openMuscle(): void {
    this.muscleOpen.set(true);
  }

  protected closeMuscle(): void {
    this.muscleOpen.set(false);
  }

  /** Escolhe o músculo na lista e fecha a folha. */
  protected pickMuscle(value: string): void {
    this.form.update((form) => ({ ...form, muscle: value }));
    this.muscleOpen.set(false);
  }

  protected setEquipment(value: string): void {
    this.form.update((form) => ({ ...form, equipment: value }));
  }

  protected setRecordType(value: string): void {
    this.form.update((form) => ({ ...form, recordType: value }));
  }

  protected setSteps(value: string): void {
    this.form.update((form) => ({ ...form, steps: value }));
  }

  protected toggleSteps(): void {
    this.stepsOpen.update((open) => !open);
  }

  protected async save(): Promise<void> {
    this.submitted.set(true);
    this.saveError.set('');
    const form = this.form();
    if (validateExerciseForm(form).length > 0 || this.saving()) return;
    this.saving.set(true);
    try {
      const result = await this.writer.saveCustomExercise({
        id: this.editing ? this.editingId : undefined,
        name: form.name,
        primaryMuscles: [form.muscle],
        equipment: form.equipment,
        recordType: form.recordType,
        instructions: parseSteps(form.steps),
      });
      switch (result.status) {
        case 'saved':
          // A ficha do exercício substitui o formulário no histórico: "voltar" não reabre um formulário já salvo.
          await this.router.navigate(['/treino/exercicios', result.exercise.id], {
            replaceUrl: true,
          });
          return;
        case 'storage-full':
          this.saveError.set(
            $localize`:@@training.form.storage-full:Sem espaço no aparelho para guardar o exercício. Libere espaço e tente de novo.`,
          );
          return;
        default:
          this.saveError.set(
            $localize`:@@training.form.not-editable:Este exercício não pode mais ser editado.`,
          );
      }
    } catch {
      this.saveError.set(
        $localize`:@@training.form.save-failed:Não deu para salvar. Confira os campos e tente de novo.`,
      );
    } finally {
      this.saving.set(false);
    }
  }

  /** Sair: sem alteração vai direto; com alteração pede a confirmação em linha. */
  protected cancel(): void {
    if (this.dirty() && !this.confirmingLeave()) {
      this.confirmingLeave.set(true);
      return;
    }
    this.leave();
  }

  protected keepEditing(): void {
    this.confirmingLeave.set(false);
  }

  protected leave(): void {
    this.back.back(this.editing ? `/treino/exercicios/${this.editingId}` : '/treino/exercicios');
  }

  /** Abre o formulário com estes valores; o que já veio preenchido não conta como alteração de quem edita. */
  private start(form: ExerciseForm): void {
    this.form.set(form);
    this.initial.set(form);
    this.stepsOpen.set(form.steps.trim() !== '');
  }

  private async loadExisting(): Promise<void> {
    const exercise = await this.catalog.get(this.editingId);
    if (!exercise || exercise.source !== 'own') {
      this.state.set('missing');
      return;
    }
    this.start({
      name: exercise.name,
      muscle: exercise.primaryMuscles[0] ?? '',
      equipment: exercise.equipment,
      recordType: exercise.recordType,
      steps: exercise.instructions.join('\n'),
    });
    this.state.set('ready');
  }

  private async checkDuplicate(name: string): Promise<void> {
    const ticket = ++this.duplicateTicket;
    if (name.trim() === '') {
      this.duplicate.set(false);
      return;
    }
    const found = await this.catalog.search({ text: name });
    if (ticket !== this.duplicateTicket) return;
    this.duplicate.set(
      found.some((row) => row.id !== this.editingId && sameExerciseName(row.name, name)),
    );
  }
}
