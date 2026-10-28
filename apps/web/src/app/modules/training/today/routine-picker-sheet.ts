import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { QUEUE_RUNTIME } from '../../../core/offline-queue/queue-ports';
import { CalendarEntryRepository } from '../data/calendar/calendar-entry-repository';
import { GoalRepository } from '../data/goals/goal-repository';
import { RoutineRepository } from '../data/routines/routine-repository';
import { dateKey, deviceTimeZone } from '../domain/progress/calendar';
import { programWeeklyGoal } from '../domain/progress/training-rhythm';
import type { RoutineEntry } from '../routines/routine-stats';
import { TrainingSheet } from '../shell/training-sheet';
import { absenceDays } from './absence-range';
import { routineSummary } from './today-text';

/**
 * Folha "Configurar Rotina": as rotinas ativas na ordem da sequência (um toque escolhe e fecha; a escolha vale só para o
 * treino de hoje) e, embaixo, as três opções da agenda pessoal: meta flexível, ausência planejada e nota do dia. Cada
 * opção grava na hora, local-first, e avisa o resultado numa linha de status.
 */
@Component({
  selector: 'app-routine-picker-sheet',
  imports: [TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="closeLabel" (closed)="closed.emit()">
      @if (entries().length > 0) {
        <ul class="list ui-group ui-plain">
          @for (entry of entries(); track entry.routine.id) {
            <li>
              <button
                type="button"
                class="ui-row"
                [attr.aria-pressed]="entry.routine.id === selectedId()"
                (click)="pick(entry)"
              >
                <span class="ui-tile">{{ entry.letter }}</span>
                <span class="ui-row-text">
                  @if (entry.next) {
                    <span class="eyebrow" i18n="@@training.today.picker-next">próxima</span>
                  }
                  <span class="ui-row-title">{{ entry.routine.name }}</span>
                  <span class="ui-row-sub">{{ summary(entry) }}</span>
                </span>
                @if (entry.routine.id === selectedId()) {
                  <span class="ui-chip accent" i18n="@@training.today.picker-selected"
                    >no cartão</span
                  >
                }
              </button>
            </li>
          }
        </ul>
      }

      <!-- As seções só aparecem com os valores já lidos: um campo preenchido depois da digitação apagaria o que a pessoa escreveu. -->
      @if (ready()) {
        <section class="settings" aria-labelledby="goal-title">
          <h3 id="goal-title" i18n="@@training.today.flexible-goal">Meta Flexível</h3>
          <label class="field">
            <span i18n="@@training.today.goal-weekly-label">Treinos por semana</span>
            <input
              #goal
              type="number"
              [attr.inputmode]="'numeric'"
              min="1"
              max="14"
              [value]="goalValue() ?? programGoal() ?? ''"
            />
          </label>
          <div class="actions">
            <button
              type="button"
              class="secondary ui-btn"
              (click)="saveGoal(goal.value)"
              i18n="@@training.today.goal-save"
            >
              Salvar Meta
            </button>
            @if (goalValue() !== null) {
              <button
                type="button"
                class="secondary ui-btn"
                (click)="resetGoal()"
                i18n="@@training.today.goal-reset"
              >
                Voltar ao Padrão
              </button>
            }
          </div>
        </section>

        <section class="settings" aria-labelledby="absence-title">
          <h3 id="absence-title" i18n="@@training.today.absence-title">Planejar Ausência</h3>
          <div class="dates">
            <label class="field">
              <span i18n="@@training.today.absence-start">De</span>
              <input #from type="date" [value]="todayKey" />
            </label>
            <label class="field">
              <span i18n="@@training.today.absence-end">Até</span>
              <input #to type="date" [value]="todayKey" />
            </label>
          </div>
          <div class="actions">
            <button
              type="button"
              class="secondary ui-btn"
              (click)="saveAbsence(from.value, to.value, true)"
              i18n="@@training.today.absence-save"
            >
              Marcar Ausência
            </button>
            <button
              type="button"
              class="secondary ui-btn"
              (click)="saveAbsence(from.value, to.value, false)"
              i18n="@@training.today.absence-undo"
            >
              Desfazer
            </button>
          </div>
        </section>

        <section class="settings" aria-labelledby="note-title">
          <h3 id="note-title" i18n="@@training.today.day-note-title">Nota do Dia</h3>
          <label class="field">
            <span class="ui-visually-hidden" i18n="@@training.today.day-note-label"
              >Nota do dia</span
            >
            <textarea
              #note
              maxlength="280"
              rows="2"
              [value]="noteValue()"
              placeholder="Lotação, dor ou equipamento"
              i18n-placeholder="@@training.today.day-note-placeholder"
            ></textarea>
          </label>
          <div class="actions">
            <button
              type="button"
              class="secondary ui-btn"
              (click)="saveNote(note.value)"
              i18n="@@training.today.day-note-save"
            >
              Salvar Nota
            </button>
          </div>
        </section>
      }

      <p class="status" role="status">{{ status() }}</p>
    </app-training-sheet>
  `,
  styles: `
    .list {
      margin: 0;
    }
    /* A folha abre com o foco na primeira linha: o anel fica por dentro dela (por fora, o grupo o cortaria numa linha solta). */
    .ui-row:focus-visible {
      outline-offset: -3px;
    }
    .eyebrow {
      color: var(--a-accent-ink);
      font-size: var(--fs-label);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .settings {
      display: grid;
      gap: var(--space-2);
      margin-top: var(--space-4);
    }
    .settings h3 {
      margin: 0;
      font-size: 1rem;
      font-weight: 800;
    }
    .actions,
    .dates {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .dates .field {
      flex: 1 1 0;
      min-width: 0;
    }
    .field {
      display: grid;
      gap: 4px;
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    input,
    textarea {
      min-height: 44px;
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm);
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      padding: 8px;
    }
    textarea {
      width: 100%;
      resize: vertical;
    }
    .status {
      min-height: 1.25em;
      margin: var(--space-3) 0 0;
      color: var(--a-accent-ink);
      font-size: var(--fs-small);
      font-weight: 700;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoutinePickerSheet {
  private readonly sheet = viewChild.required(TrainingSheet);
  private readonly goals = inject(GoalRepository);
  private readonly calendarEntries = inject(CalendarEntryRepository);
  private readonly routines = inject(RoutineRepository);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly zone = deviceTimeZone();

  readonly entries = input.required<readonly RoutineEntry[]>();
  readonly selectedId = input<string | null>(null);

  readonly picked = output<string>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.today.picker-title:Configurar Rotina`;
  protected readonly closeLabel = $localize`:@@training.today.picker-close:Fechar`;
  protected readonly todayKey = dateKey(this.runtime.now(), this.zone);
  /** A meta que a pessoa definiu; `null` enquanto vale a do programa. */
  protected readonly goalValue = signal<number | null>(null);
  /** O padrão do programa ativo, mostrado no campo enquanto não há ajuste. */
  protected readonly programGoal = signal<number | null>(null);
  protected readonly noteValue = signal('');
  protected readonly status = signal('');
  protected readonly ready = signal(false);

  constructor() {
    void this.loadSettings();
  }

  protected summary(entry: RoutineEntry): string {
    return routineSummary(entry);
  }

  protected pick(entry: RoutineEntry): void {
    this.picked.emit(entry.routine.id);
    this.sheet().close();
  }

  protected async saveGoal(value: string): Promise<void> {
    const result = await this.goals.set('weekly_sessions', Number(value));
    if (result.status === 'saved') {
      this.goalValue.set(result.goal.value);
      this.status.set($localize`:@@training.today.goal-saved:Meta salva`);
    } else {
      this.status.set($localize`:@@training.today.goal-invalid:Use de 1 a 14 treinos por semana`);
    }
  }

  protected async resetGoal(): Promise<void> {
    await this.goals.clear('weekly_sessions');
    this.goalValue.set(null);
    this.status.set($localize`:@@training.today.goal-restored:Meta do programa restaurada`);
  }

  /** Marca (ou desfaz) cada dia do intervalo; desfazer mantém a nota do dia e só apaga a ausência. */
  protected async saveAbsence(from: string, to: string, absent: boolean): Promise<void> {
    const days = absenceDays(from, to);
    if (days.length === 0) {
      this.status.set($localize`:@@training.today.absence-invalid:Escolha um intervalo válido`);
      return;
    }
    for (const day of days) {
      const current = await this.calendarEntries.get(day);
      await this.calendarEntries.save(day, { absent, note: current?.note ?? '' });
    }
    this.status.set(
      absent
        ? $localize`:@@training.today.absence-saved:Ausência marcada`
        : $localize`:@@training.today.absence-undone:Ausência desfeita`,
    );
  }

  protected async saveNote(note: string): Promise<void> {
    const current = await this.calendarEntries.get(this.todayKey);
    await this.calendarEntries.save(this.todayKey, { absent: current?.absent ?? false, note });
    this.noteValue.set(note.trim());
    this.status.set($localize`:@@training.today.day-note-saved:Nota salva`);
  }

  private async loadSettings(): Promise<void> {
    const [goal, routines, programId, entry] = await Promise.all([
      this.goals.value('weekly_sessions'),
      this.routines.list(),
      this.routines.activeProgramId(),
      this.calendarEntries.get(this.todayKey),
    ]);
    this.goalValue.set(goal);
    this.programGoal.set(programWeeklyGoal(routines, programId));
    this.noteValue.set(entry?.note ?? '');
    this.ready.set(true);
  }
}
