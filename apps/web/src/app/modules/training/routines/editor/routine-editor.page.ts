import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import { CatalogRepository } from '../../data/catalog/catalog-repository';
import type { LocalExercise } from '../../data/catalog/exercise';
import { RoutineRepository } from '../../data/routines/routine-repository';
import { TrainingSync } from '../../data/sync/training-sync';
import type { RoutineItemModel } from '../../domain/routines/routine-model';
import { ExercisePickerSheet } from '../../exercises/picker/exercise-picker-sheet';
import { BackNavigation } from '../../shell/back-navigation';
import { awaitingFirstPull } from '../../shell/first-pull';
import { TrainingGlyph } from '../../shell/training-glyph';
import {
  ItemField,
  RoutineDraftState,
  appendItem,
  draftFromRoutine,
  dropItemOn,
  emptyDraft,
  hasErrors,
  isDraftDirty,
  newDraftItem,
  removeItem,
  shiftItem,
  stepItem,
  toSaveDraft,
  toggleLink,
  validateDraft,
} from './routine-draft';

interface FieldConfig {
  readonly key: ItemField;
  readonly label: string;
  readonly less: string;
  readonly more: string;
  readonly suffix: string;
}

/**
 * Editor de rotina. Trabalha numa cópia: nada é gravado até "Salvar rotina". Cada exercício é uma linha curta (nome e a
 * meta resumida); um toque nela abre os ajustes (séries, repetições, descanso, supersérie, remover). A ordem muda por
 * Subir e Descer (o caminho principal, que o teclado e o leitor de tela alcançam) ou arrastando pela alça (um extra,
 * por eventos de ponteiro). Sem a barra de abas: sair com alterações pede confirmação ali mesmo.
 */
@Component({
  selector: 'app-routine-editor-page',
  imports: [TrainingGlyph, ExercisePickerSheet],
  templateUrl: './routine-editor.page.html',
  styleUrl: './routine-editor.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoutineEditorPage {
  private readonly routines = inject(RoutineRepository);
  private readonly catalog = inject(CatalogRepository);
  private readonly back = inject(BackNavigation);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly routineId = this.route.snapshot.paramMap.get('id') ?? '';
  protected readonly editing = this.routineId !== '';

  protected readonly state = signal<'loading' | 'missing' | 'ready'>('loading');
  protected readonly draft = signal<RoutineDraftState>(emptyDraft());
  private readonly initial = signal<RoutineDraftState>(emptyDraft());
  /** Os exercícios pelos ids, para o nome de cada linha. */
  private readonly exercises = signal<ReadonlyMap<string, LocalExercise>>(new Map());

  protected readonly expandedId = signal<string | null>(null);
  protected readonly removingId = signal<string | null>(null);
  protected readonly draggingId = signal<string | null>(null);
  protected readonly pickerOpen = signal(false);
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly confirmingLeave = signal(false);
  protected readonly confirmingDelete = signal(false);

  protected readonly errors = computed(() =>
    this.submitted() ? validateDraft(this.draft()) : { reps: new Set<string>() },
  );
  protected readonly dirty = computed(() => isDraftDirty(this.initial(), this.draft()));

  protected readonly title = this.editing
    ? $localize`:@@training.editor.title-edit:Editar rotina`
    : $localize`:@@training.editor.title-new:Nova rotina`;
  protected readonly backLabel = $localize`:@@training.editor.back:Sair do editor`;
  protected readonly itemsLabel = $localize`:@@training.editor.items-label:Exercícios da rotina`;
  protected readonly dragHint = $localize`:@@training.editor.hint:Mude a ordem com as setas, ou arraste pela alça.`;

  protected readonly fields: readonly FieldConfig[] = [
    {
      key: 'targetSets',
      label: $localize`:@@training.editor.sets:Séries`,
      less: $localize`:@@training.editor.sets-less:Diminuir séries`,
      more: $localize`:@@training.editor.sets-more:Aumentar séries`,
      suffix: '',
    },
    {
      key: 'restSeconds',
      label: $localize`:@@training.editor.rest:Descanso`,
      less: $localize`:@@training.editor.rest-less:Diminuir descanso`,
      more: $localize`:@@training.editor.rest-more:Aumentar descanso`,
      suffix: ' s',
    },
    {
      key: 'repMin',
      label: $localize`:@@training.editor.rep-min:Repetições (mín.)`,
      less: $localize`:@@training.editor.rep-min-less:Diminuir repetições mínimas`,
      more: $localize`:@@training.editor.rep-min-more:Aumentar repetições mínimas`,
      suffix: '',
    },
    {
      key: 'repMax',
      label: $localize`:@@training.editor.rep-max:Repetições (máx.)`,
      less: $localize`:@@training.editor.rep-max-less:Diminuir repetições máximas`,
      more: $localize`:@@training.editor.rep-max-more:Aumentar repetições máximas`,
      suffix: '',
    },
  ];

  /** Verdadeiro depois que o editor abriu a rotina: as releituras seguintes não mexem mais no que a pessoa editou. */
  private opened = false;

  constructor() {
    if (this.editing) {
      // Aberto direto pelo endereço na primeira vez, o editor espera a primeira passada do servidor trazer a rotina.
      effect(() => {
        this.routines.revision();
        const waiting = awaitingFirstPull(this.sync, this.connectivity);
        untracked(() => void this.openExisting(waiting));
      });
    } else {
      void this.startNew();
    }

    // Os nomes das linhas: lê do catálogo local o que ainda não foi lido (exercício novo na lista, ou apagado).
    effect(() => {
      const ids = this.draft().items.map((item) => item.exerciseId);
      untracked(() => void this.loadNames(ids));
    });
  }

  protected nameOf(item: RoutineItemModel): string {
    return (
      this.exercises().get(item.exerciseId)?.name ??
      $localize`:@@training.editor.missing-exercise:Exercício que não existe mais`
    );
  }

  protected summaryOf(item: RoutineItemModel): string {
    const sets = item.targetSets;
    const text =
      sets === 1
        ? $localize`:@@training.editor.summary-one:1 série · ${item.repMin}:min:–${item.repMax}:max: reps · ${item.restSeconds}:rest: s`
        : $localize`:@@training.editor.summary-many:${sets}:sets: séries · ${item.repMin}:min:–${item.repMax}:max: reps · ${item.restSeconds}:rest: s`;
    return text;
  }

  protected fieldValue(item: RoutineItemModel, field: FieldConfig): string {
    return `${item[field.key]}${field.suffix}`;
  }

  protected isLinked(index: number): boolean {
    const items = this.draft().items;
    const group = items[index]?.supersetGroup ?? null;
    return group !== null && items[index + 1]?.supersetGroup === group;
  }

  protected upLabel(item: RoutineItemModel): string {
    const name = this.nameOf(item);
    return $localize`:@@training.editor.up:Subir ${name}:name:`;
  }

  protected downLabel(item: RoutineItemModel): string {
    const name = this.nameOf(item);
    return $localize`:@@training.editor.down:Descer ${name}:name:`;
  }

  protected removeLabel(item: RoutineItemModel): string {
    const name = this.nameOf(item);
    return $localize`:@@training.editor.remove-label:Remover da rotina: ${name}:name:`;
  }

  protected setName(value: string): void {
    this.draft.update((draft) => ({ ...draft, name: value }));
  }

  protected setActive(active: boolean): void {
    this.draft.update((draft) => ({ ...draft, active }));
  }

  protected toggle(id: string): void {
    this.expandedId.update((current) => (current === id ? null : id));
    this.removingId.set(null);
  }

  // ---- ordem, metas e supersérie ----

  protected shift(id: string, delta: -1 | 1): void {
    this.draft.update((draft) => ({ ...draft, items: shiftItem(draft.items, id, delta) }));
    // A linha muda de lugar na lista e o botão apertado vai com ela; devolve o foco para ele (ou para o par, na ponta).
    afterNextRender(
      () => {
        const row = this.host.nativeElement.querySelector<HTMLElement>(`[data-id="${id}"]`);
        const wanted = row?.querySelector<HTMLButtonElement>(delta < 0 ? '.move.up' : '.move.down');
        (wanted && !wanted.disabled
          ? wanted
          : row?.querySelector<HTMLButtonElement>('.move:not(:disabled)')
        )?.focus();
      },
      { injector: this.injector },
    );
  }

  protected step(id: string, field: ItemField, direction: -1 | 1): void {
    this.draft.update((draft) => ({
      ...draft,
      items: stepItem(draft.items, id, field, direction),
    }));
  }

  protected link(id: string): void {
    this.draft.update((draft) => ({ ...draft, items: toggleLink(draft.items, id) }));
  }

  protected askRemove(id: string): void {
    this.removingId.set(id);
  }

  protected keepItem(): void {
    this.removingId.set(null);
  }

  protected removeItemNow(id: string): void {
    this.draft.update((draft) => ({ ...draft, items: removeItem(draft.items, id) }));
    this.removingId.set(null);
    this.expandedId.set(null);
  }

  // ---- arrastar (extra) ----

  protected startDrag(event: PointerEvent, id: string): void {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.draggingId.set(id);
  }

  protected dragOver(event: PointerEvent): void {
    const id = this.draggingId();
    if (!id) return;
    const doc = this.host.nativeElement.ownerDocument;
    const target = doc
      .elementFromPoint?.(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-id]');
    const overId = target?.dataset['id'];
    if (!overId || overId === id) return;
    this.draft.update((draft) => ({ ...draft, items: dropItemOn(draft.items, id, overId) }));
  }

  protected endDrag(): void {
    this.draggingId.set(null);
  }

  // ---- adicionar exercício ----

  protected openPicker(): void {
    this.pickerOpen.set(true);
  }

  protected closePicker(): void {
    this.pickerOpen.set(false);
  }

  protected onPicked(exercise: LocalExercise): void {
    this.add(exercise);
  }

  // ---- salvar, sair e apagar ----

  protected async save(): Promise<void> {
    this.submitted.set(true);
    this.saveError.set('');
    const draft = this.draft();
    const errors = validateDraft(draft);
    if (hasErrors(errors)) {
      // Abre a primeira linha com problema para o erro aparecer onde está.
      const first = draft.items.find((item) => errors.reps.has(item.id));
      if (first) this.expandedId.set(first.id);
      return;
    }
    if (this.saving()) return;
    this.saving.set(true);
    try {
      const result = await this.routines.save(toSaveDraft(draft));
      switch (result.status) {
        case 'saved':
          // A lista substitui o editor no histórico: "voltar" não reabre um editor já salvo.
          await this.router.navigate(['/treino/rotinas'], { replaceUrl: true });
          return;
        case 'storage-full':
          this.saveError.set(
            $localize`:@@training.editor.storage-full:Sem espaço no aparelho para guardar a rotina. Libere espaço e tente de novo.`,
          );
          return;
        default:
          this.saveError.set($localize`:@@training.editor.gone:Esta rotina não existe mais.`);
      }
    } catch {
      this.saveError.set(
        $localize`:@@training.editor.save-failed:Não deu para salvar. Confira os campos e tente de novo.`,
      );
    } finally {
      this.saving.set(false);
    }
  }

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
    this.back.back('/treino/rotinas');
  }

  protected askDelete(): void {
    this.confirmingDelete.set(true);
  }

  protected keepRoutine(): void {
    this.confirmingDelete.set(false);
  }

  protected async deleteRoutine(): Promise<void> {
    const result = await this.routines.softDelete(this.routineId);
    if (result.status === 'storage-full') {
      this.saveError.set(
        $localize`:@@training.editor.delete-storage:Sem espaço no aparelho para guardar a mudança. Libere espaço e tente de novo.`,
      );
      this.confirmingDelete.set(false);
      return;
    }
    await this.router.navigate(['/treino/rotinas'], { replaceUrl: true });
  }

  private add(exercise: LocalExercise): void {
    const items = this.draft().items;
    const id = uuidV7();
    const next = appendItem(items, newDraftItem(id, exercise.id, items.length));
    if (next === null) {
      this.saveError.set(
        $localize`:@@training.editor.full:A rotina já está com o máximo de exercícios.`,
      );
      return;
    }
    this.saveError.set('');
    this.draft.update((draft) => ({ ...draft, items: next }));
    this.exercises.update((current) => new Map(current).set(exercise.id, exercise));
    // O exercício novo cai no fim da lista: leva a tela até ele.
    afterNextRender(
      () => {
        this.host.nativeElement
          .querySelector<HTMLElement>(`[data-id="${id}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      },
      { injector: this.injector },
    );
  }

  private async openExisting(waitingForServer: boolean): Promise<void> {
    if (this.opened) return;
    const routine = await this.routines.get(this.routineId);
    if (this.opened) return;
    if (routine) {
      this.opened = true;
      this.open(draftFromRoutine(routine));
      this.state.set('ready');
    } else {
      this.state.set(waitingForServer ? 'loading' : 'missing');
    }
  }

  private async startNew(): Promise<void> {
    // Rotina nova: o nome já vem sugerido ("Treino C") e, vindo da ficha de um exercício, ele já está na lista.
    const letter = String.fromCharCode(65 + ((await this.routines.listAll()).length % 26));
    let draft = emptyDraft($localize`:@@training.editor.suggested-name:Treino ${letter}:letter:`);
    const exerciseId = this.route.snapshot.queryParamMap.get('exercicio');
    if (exerciseId) {
      const exercise = await this.catalog.get(exerciseId);
      if (exercise) {
        draft = { ...draft, items: [newDraftItem(uuidV7(), exercise.id, 0)] };
        this.exercises.update((current) => new Map(current).set(exercise.id, exercise));
      }
    }
    this.open(draft);
    this.state.set('ready');
  }

  /** Abre o editor com a rotina: o que já veio preenchido não conta como alteração de quem edita. */
  private open(draft: RoutineDraftState): void {
    this.draft.set(draft);
    this.initial.set(draft);
  }

  private async loadNames(ids: readonly string[]): Promise<void> {
    const known = this.exercises();
    const missing = [...new Set(ids)].filter((id) => !known.has(id));
    if (missing.length === 0) return;
    const rows = await Promise.all(missing.map((id) => this.catalog.get(id)));
    const found = rows.filter((row): row is LocalExercise => row !== undefined);
    if (found.length === 0) return;
    this.exercises.update((current) => {
      const next = new Map(current);
      for (const row of found) next.set(row.id, row);
      return next;
    });
  }
}
