import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { RoutineRepository } from '../data/routines/routine-repository';
import { SessionRepository } from '../data/sessions/session-repository';
import { ExercisesSwitch } from '../shell/exercises-switch';
import { TrainingGlyph } from '../shell/training-glyph';
import { RoutineEntry, buildRoutineEntries } from './routine-stats';
import { TemplateCreated, TemplatesSheet } from './templates-sheet';

/**
 * Lista de rotinas, na ordem da sequência (A, B, C...). Cada linha leva ao editor; "Nova rotina" é a ação principal e
 * "Usar modelo" traz os programas prontos (só com rede, porque os modelos vêm do servidor).
 */
@Component({
  selector: 'app-routines-list-page',
  imports: [RouterLink, ExercisesSwitch, TrainingGlyph, TemplatesSheet],
  templateUrl: './routines-list.page.html',
  styleUrl: './routines-list.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoutinesListPage {
  private readonly routines = inject(RoutineRepository);
  private readonly sessions = inject(SessionRepository);
  private readonly connectivity = inject(ConnectivityService);

  protected readonly entries = signal<readonly RoutineEntry[]>([]);
  protected readonly ready = signal(false);
  protected readonly templatesOpen = signal(false);
  protected readonly notice = signal<{
    readonly tone: 'ok' | 'warn';
    readonly text: string;
  } | null>(null);
  protected readonly online = this.connectivity.online;

  protected readonly countText = computed(() => {
    const count = this.entries().length;
    return count === 1
      ? $localize`:@@training.routines.count-one:1 rotina · na ordem da sequência`
      : $localize`:@@training.routines.count-many:${count}:count: rotinas · na ordem da sequência`;
  });

  constructor() {
    effect(() => {
      this.routines.revision();
      untracked(() => void this.load());
    });
  }

  protected summary(entry: RoutineEntry): string {
    const exercises =
      entry.exercises === 1
        ? $localize`:@@training.routines.exercises-one:1 exercício`
        : $localize`:@@training.routines.exercises-many:${entry.exercises}:count: exercícios`;
    const sets =
      entry.sets === 1
        ? $localize`:@@training.routines.sets-one:1 série`
        : $localize`:@@training.routines.sets-many:${entry.sets}:count: séries`;
    const parts = [exercises, sets];
    if (entry.minutes !== null) {
      const minutes = entry.minutes;
      parts.push($localize`:@@training.routines.minutes:cerca de ${minutes}:minutes: min`);
    }
    return parts.join(' · ');
  }

  protected openTemplates(): void {
    this.notice.set(null);
    this.templatesOpen.set(true);
  }

  protected closeTemplates(): void {
    this.templatesOpen.set(false);
  }

  protected onCreated(event: TemplateCreated): void {
    const name = event.name;
    const count = event.count;
    const createdText =
      count === 1
        ? $localize`:@@training.templates.done-one:Criamos 1 rotina do modelo ${name}:name:.`
        : $localize`:@@training.templates.done-many:Criamos ${count}:count: rotinas do modelo ${name}:name:.`;
    const text = event.draft
      ? `${createdText} ${$localize`:@@training.templates.draft-created:Elas ficaram inativas, fora da sequência. Revise e ative quando estiverem completas.`}`
      : createdText;
    if (event.missing > 0) {
      const missing = event.missing;
      const extra =
        missing === 1
          ? $localize`:@@training.templates.missing-one:1 exercício do modelo não está no seu catálogo e ficou de fora.`
          : $localize`:@@training.templates.missing-many:${missing}:count: exercícios do modelo não estão no seu catálogo e ficaram de fora.`;
      this.notice.set({ tone: 'warn', text: `${text} ${extra}` });
    } else {
      this.notice.set({ tone: 'ok', text });
    }
  }

  private async load(): Promise<void> {
    const [all, alive, sessions] = await Promise.all([
      this.routines.all(),
      this.routines.listAll(),
      this.sessions.sessionsBetween(0, Number.MAX_SAFE_INTEGER),
    ]);
    this.entries.set(buildRoutineEntries(all, alive, sessions));
    this.ready.set(true);
  }
}
