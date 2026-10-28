import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  Injector,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { LocalExercise } from '../data/catalog/exercise';
import { RestTimerService } from '../data/session-live/rest-timer.service';
import { WakeLockService } from '../data/session-live/wake-lock.service';
import type { LocalSet } from '../data/sessions/session';
import { summarizeLastSets } from '../exercises/last-set';
import { illustrationFor, illustrationUrl } from '../illustrations/illustration-map';
import { equipmentLabel, muscleLabel } from '../domain/taxonomy';
import { formatKg } from '../shell/format';
import { TrainingGlyph } from '../shell/training-glyph';
import { ExerciseIllustration } from '../illustrations/exercise-illustration';
import { ExerciseChooserSheet } from './exercise-chooser-sheet';
import { FocusHint, type Tip } from './focus-hint';
import { HowToSheet } from './how-to-sheet';
import { LiveStore } from './live-store';
import { PlanSheet } from './plan-sheet';
import { RestCard } from './rest-card';
import { EMPTY_FIELDS, type SetFields } from './set-draft';
import { SetEditSheet } from './set-edit-sheet';
import { LiveSetFields } from './set-fields';
import { type MenuAction, SessionMenuSheet } from './session-menu-sheet';
import { TodayGlyph } from './today-glyph';
import { TodayStore } from './today-store';
import {
  awaitingSetsText,
  repsRangeText,
  setText,
  suggestionReasonText,
  suggestionText,
} from './today-text';

type Sheet = 'menu' | 'plan' | 'swap' | 'add' | 'steps' | 'edit' | null;

/** Uma série já feita, pronta para a lista (texto, esforço, marca de recorde). */
interface DoneRow {
  readonly set: LocalSet;
  readonly number: number;
  readonly text: string;
  readonly detail: string;
  readonly record: boolean;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * O treino ao vivo, na tela do celular de quem está em pé na academia: o exercício em foco, o descanso, a série atual
 * com − e + grandes e UMA ação principal ("Concluir série") sempre ao alcance do polegar. O resto (pular, substituir,
 * a lista de exercícios, tela acesa, terminar e cancelar) fica atrás do menu. O estado todo vem do `LiveStore`: recarregar
 * a página volta à mesma série e ao mesmo descanso.
 */
@Component({
  selector: 'app-live-session',
  imports: [
    TrainingGlyph,
    TodayGlyph,
    RestCard,
    FocusHint,
    LiveSetFields,
    SessionMenuSheet,
    PlanSheet,
    ExerciseChooserSheet,
    HowToSheet,
    SetEditSheet,
    ExerciseIllustration,
  ],
  templateUrl: './live-session.html',
  styleUrl: './live-session.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveSession {
  protected readonly live = inject(LiveStore);
  private readonly today = inject(TodayStore);
  protected readonly timer = inject(RestTimerService);
  private readonly wake = inject(WakeLockService);
  private readonly injector = inject(Injector);
  private readonly win = inject(DOCUMENT).defaultView;

  /** Voltar ao treino em andamento. */
  readonly back = output<void>();
  /** Terminou o treino: o id dele, para abrir o resumo. */
  readonly finished = output<string>();
  /** Uma ficha do plano acabou; a escolha do próximo aparelho volta para a tela do dia. */
  readonly exerciseCompleted = output<void>();
  /** Cancelou o treino. */
  readonly discarded = output<void>();

  private readonly title = viewChild<ElementRef<HTMLElement>>('title');
  private readonly dock = viewChild<ElementRef<HTMLButtonElement>>('dock');

  protected readonly sheet = signal<Sheet>(null);
  protected readonly editing = signal<LocalSet | null>(null);
  protected readonly draft = signal<SetFields>(EMPTY_FIELDS);
  protected readonly screenRefused = signal(false);
  /** A pessoa está saindo do treino (terminar ou cancelar): a tela não mostra o vazio que sobra no meio do caminho. */
  protected readonly leaving = signal(false);

  protected readonly screenSupported = this.wake.supported;
  protected readonly screenOn = this.wake.active;
  /** O aparelho vibra? O iPhone não: o aviso do fim do descanso fica só na tela. */
  protected readonly canVibrate = typeof this.win?.navigator.vibrate === 'function';

  protected readonly exercise = this.live.focusExercise;
  protected readonly focus = this.live.focus;

  protected readonly heading = this.live.workoutName;

  /** "Série 2 de 3", "Série extra" ou "Série 3" (exercício fora da rotina, sem meta). */
  protected readonly setTitle = computed(() => {
    const focus = this.focus();
    if (focus === null) return '';
    const set = focus.setNumber;
    if (focus.extra && focus.targetSets !== null) {
      return $localize`:@@training.live.set-extra:Série extra`;
    }
    if (focus.targetSets === null) return $localize`:@@training.live.set-n:Série ${set}:set:`;
    const planned = focus.targetSets;
    return $localize`:@@training.live.set-of:Série ${set}:set: de ${planned}:planned:`;
  });

  protected readonly repsRange = computed(() => {
    const focus = this.focus();
    return focus === null ? '' : repsRangeText(focus.repMin, focus.repMax);
  });

  protected readonly thumb = computed(() => {
    const exercise = this.exercise();
    const art = exercise ? illustrationFor(exercise.slug) : undefined;
    return art ? illustrationUrl(art.frames[0]) : null;
  });

  protected readonly chips = computed(() => {
    const exercise = this.exercise();
    const focus = this.focus();
    if (exercise === undefined || focus === null) return [];
    const list: { text: string; accent: boolean }[] = [];
    const muscle = exercise.primaryMuscles[0];
    if (muscle) list.push({ text: muscleLabel(muscle), accent: false });
    list.push({ text: equipmentLabel(exercise.equipment), accent: false });
    if (this.screenOn()) {
      list.push({ text: $localize`:@@training.live.screen-on-chip:tela acesa`, accent: true });
    }
    if (focus.swapped) {
      list.push({ text: $localize`:@@training.live.swapped:trocado só hoje`, accent: true });
    }
    if (focus.supersetGroup !== null) {
      list.push({ text: $localize`:@@training.live.superset:supersérie`, accent: false });
    }
    if (focus.position === null && this.live.routine() !== undefined) {
      list.push({ text: $localize`:@@training.live.extra:extra`, accent: false });
    }
    return list;
  });

  /** A sugestão do dia e a última vez, em texto; vazio quando o exercício nunca foi feito. */
  protected readonly lastText = computed(() => {
    const info = this.live.info();
    const exercise = this.exercise();
    if (info === null || exercise === undefined || info.exerciseId !== exercise.id) return null;
    const sets = info.last?.sets ?? [];
    if (sets.length === 0) return null;
    return summarizeLastSets(sets, exercise.recordType);
  });
  protected readonly suggestion = computed<Tip | null>(() => {
    const info = this.live.info();
    const exercise = this.exercise();
    if (info === null || exercise === undefined || info.exerciseId !== exercise.id) return null;
    if (info.suggestion.weightKg === null || exercise.recordType !== 'weight_reps') return null;
    return {
      text: suggestionText(info.suggestion),
      reason: suggestionReasonText(info.suggestion.reason),
    };
  });
  protected readonly firstTime = computed(() => {
    const info = this.live.info();
    const exercise = this.exercise();
    return (
      info !== null &&
      exercise !== undefined &&
      info.exerciseId === exercise.id &&
      info.last === null
    );
  });

  protected readonly doneRows = computed<DoneRow[]>(() => {
    const exercise = this.exercise();
    if (exercise === undefined) return [];
    const flags = this.live.recordFlags();
    let worked = 0;
    return this.live.focusSets().map((set) => {
      const isWork = set.setType !== 'warmup';
      if (isWork) worked++;
      const parts: string[] = [];
      if (!isWork) parts.push($localize`:@@training.live.warmup-tag:aquecimento`);
      if (set.rpe !== null) {
        const rpe = set.rpe;
        parts.push($localize`:@@training.live.rpe-tag:esforço ${rpe}:rpe:`);
      }
      if (set.note !== '') parts.push(set.note);
      return {
        set,
        number: isWork ? worked : 0,
        text: setText(set, exercise.recordType),
        detail: parts.join(' · '),
        record: flags.has(set.id),
      };
    });
  });

  protected readonly names = computed(
    () => new Map([...this.live.exercises()].map(([id, exercise]) => [id, exercise.name])),
  );
  /**
   * Exercícios que não servem de troca: os que já estão na rotina de hoje e o próprio exercício em foco. O previsto pela
   * rotina só volta à lista quando ele foi trocado (escolhê-lo desfaz a troca).
   */
  protected readonly swapExcluded = computed(() => {
    const focus = this.focus();
    const keep = focus?.swapped ? focus.planExerciseId : null;
    return this.live
      .plan()
      .entries.flatMap((entry) => [entry.exerciseId, entry.planExerciseId])
      .filter((id) => id !== keep);
  });

  protected readonly bannerLines = computed(() => {
    const banner = this.live.banner();
    if (banner === null) return [];
    const lines: string[] = [];
    if (banner.maxWeight !== null) {
      const now = formatKg(banner.maxWeight.weightKg);
      const before = formatKg(banner.maxWeight.previousKg);
      lines.push(
        $localize`:@@training.live.record-max:carga máxima ${now}:now: (antes ${before}:before:)`,
      );
    }
    if (banner.oneRepMax !== null) {
      const now = formatKg(round1(banner.oneRepMax.valueKg));
      const before = formatKg(round1(banner.oneRepMax.previousKg));
      lines.push(
        $localize`:@@training.live.record-1rm:1RM estimado ${now}:now: (antes ${before}:before:)`,
      );
    }
    return lines;
  });

  /** Quando o descanso acaba, a região "educada" lê isto em voz alta (o cartão do descanso também muda de cor). */
  protected readonly restOverText = computed(() =>
    this.timer.over() ? $localize`:@@training.live.rest-over-say:Descanso terminou` : '',
  );

  /** "3 séries aguardando envio": só as séries deste treino que ainda não chegaram ao servidor. */
  protected readonly awaitingText = computed(() => awaitingSetsText(this.today.awaitingSets()));

  protected readonly canSwitch = computed(() => this.focus()?.itemId != null);
  protected readonly hasSteps = computed(() => {
    const exercise = this.exercise();
    return exercise !== undefined && (exercise.instructions.length > 0 || this.thumb() !== null);
  });

  protected readonly swapHeading = $localize`:@@training.live.swap-title:Substituir Exercício`;
  protected readonly addHeading = $localize`:@@training.live.add-title:Adicionar Exercício`;
  protected readonly backLabel = $localize`:@@training.live.back:Voltar ao treino`;
  protected readonly menuLabel = $localize`:@@training.live.menu:Opções do treino`;
  protected readonly dismissLabel = $localize`:@@training.live.record-dismiss:Dispensar o aviso de recorde`;

  constructor() {
    void this.timer.restore();
    let appliedKey = '';
    let appliedFill = '';
    let applied: SetFields | null = null;
    // O cartão recomeça (preenchido com a última vez) quando muda o exercício, a série ou o que há de gravado; e, se a
    // pessoa ainda não mexeu nele, também quando o histórico chega depois (primeira leitura do servidor).
    effect(() => {
      const defaults = this.live.defaults();
      untracked(() => {
        if (defaults === null) return;
        const newCard = defaults.key !== appliedKey;
        const untouched = applied !== null && this.draft() === applied;
        if (newCard || (defaults.fill !== appliedFill && untouched)) {
          appliedKey = defaults.key;
          appliedFill = defaults.fill;
          applied = defaults.fields;
          this.draft.set(defaults.fields);
        }
      });
    });
    // O que a pessoa muda no cartão limpa a borda de erro do campo.
    effect(() => {
      this.draft();
      untracked(() => this.live.issue.set(null));
    });
    // O foco vai para o título ao abrir: quem usa leitor de tela ouve em que treino está.
    afterNextRender(() => this.title()?.nativeElement.focus({ preventScroll: true }), {
      injector: this.injector,
    });
    // A tela acesa é só enquanto esta tela existe: sair do treino solta o bloqueio.
    inject(DestroyRef).onDestroy(() => void this.wake.release());
  }

  protected setWarmup(checked: boolean): void {
    this.draft.update((current) => ({ ...current, warmup: checked }));
  }

  protected async complete(): Promise<void> {
    const closes = this.live.closesExercise();
    const outcome = await this.live.completeSet(this.draft());
    // O foco só volta ao botão depois de gravar: nenhum toque se perde no meio do caminho. No descanso o botão fica
    // escondido e o foco vai para o título.
    if (outcome !== 'ignored') {
      const target = this.timer.active() ? this.title() : this.dock();
      target?.nativeElement.focus({ preventScroll: true });
    }
    if (outcome === 'saved' && closes) this.exerciseCompleted.emit();
  }

  protected async primary(): Promise<void> {
    if (this.focus() !== null) await this.complete();
    else if (this.live.plan().planDone) await this.finish();
    else this.sheet.set('add');
  }

  protected openEdit(set: LocalSet): void {
    this.editing.set(set);
    this.sheet.set('edit');
  }

  protected async onMenu(action: MenuAction): Promise<void> {
    switch (action) {
      case 'steps':
        this.sheet.set('steps');
        break;
      case 'skip':
        this.sheet.set(null);
        await this.live.skipCurrent();
        this.live.say(
          $localize`:@@training.live.skipped-say:Exercício pulado. Para voltar a ele, abra Exercícios do treino.`,
          'info',
        );
        break;
      case 'swap':
        this.sheet.set('swap');
        break;
      case 'plan':
        this.sheet.set('plan');
        break;
      case 'add':
        this.sheet.set('add');
        break;
      case 'follow':
        this.sheet.set(null);
        await this.live.choose(null);
        break;
      case 'finish':
        await this.finish();
        break;
      case 'discard':
        await this.discard();
        break;
    }
  }

  protected async onScreen(on: boolean): Promise<void> {
    this.screenRefused.set(false);
    if (on) {
      const granted = await this.wake.request();
      if (!granted) {
        // Sem suporte ou recusado: o interruptor volta a desligado e a folha diz por quê.
        await this.wake.release();
        this.screenRefused.set(this.wake.supported());
      }
    } else {
      await this.wake.release();
    }
  }

  protected async finishExerciseFromRest(): Promise<void> {
    // O descanso era deste exercício: encerrá-lo encerra o relógio, para o próximo não abrir já em descanso.
    await this.timer.skip();
    await this.live.skipCurrent();
    this.exerciseCompleted.emit();
  }

  protected async chooseEntry(key: string): Promise<void> {
    this.sheet.set(null);
    await this.live.choose(key);
  }

  protected async swapTo(exercise: LocalExercise): Promise<void> {
    const outcome = await this.live.swapCurrent(exercise);
    if (outcome === 'in-routine') {
      this.live.say(
        $localize`:@@training.live.swap-taken:Esse exercício já está na rotina de hoje. Escolha outro.`,
        'warn',
      );
    } else if (outcome === 'swapped') {
      const name = exercise.name;
      this.live.say(
        $localize`:@@training.live.swapped-say:Hoje você faz ${name}:name: no lugar.`,
        'info',
      );
    }
  }

  protected async addTo(exercise: LocalExercise): Promise<void> {
    await this.live.addExercise(exercise);
  }

  protected async finish(): Promise<void> {
    this.leaving.set(true);
    const id = await this.live.finish();
    if (id === null) {
      this.leaving.set(false);
      return;
    }
    await this.wake.release();
    this.sheet.set(null);
    this.finished.emit(id);
  }

  private async discard(): Promise<void> {
    this.leaving.set(true);
    if (!(await this.live.discard())) {
      this.leaving.set(false);
      return;
    }
    await this.wake.release();
    this.sheet.set(null);
    this.discarded.emit();
  }
}
