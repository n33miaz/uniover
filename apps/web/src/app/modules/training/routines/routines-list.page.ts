import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { RoutineRepository } from '../data/routines/routine-repository';
import type { LocalSession } from '../data/sessions/session';
import { SessionRepository } from '../data/sessions/session-repository';
import { ExercisesSwitch } from '../shell/exercises-switch';
import { TrainingGlyph } from '../shell/training-glyph';
import { SwapStore } from '../today/swap-store';
import { RoutineEntry, buildRoutineEntries } from './routine-stats';
import { TemplateCreated, TemplatesSheet } from './templates-sheet';

/**
 * Lista de rotinas, na ordem da sequência (A, B, C...). A próxima abre em destaque; a lista compacta fica sob demanda,
 * e a comparação de modelos usa rede porque os programas prontos vêm do servidor.
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
  private readonly router = inject(Router);
  private readonly swaps = inject(SwapStore);

  protected readonly entries = signal<readonly RoutineEntry[]>([]);
  protected readonly ready = signal(false);
  protected readonly templatesOpen = signal(false);
  protected readonly starting = signal(false);
  /** O treino aberto neste aparelho: o botão da próxima rotina vira "Continuar" quando ele é dela. */
  private readonly activeSession = signal<LocalSession | undefined>(undefined);
  protected readonly notice = signal<{
    readonly tone: 'ok' | 'warn';
    readonly text: string;
  } | null>(null);
  protected readonly online = this.connectivity.online;
  /** A próxima fica visível sem esforço; a lista completa só aparece quando a pessoa pede. */
  private readonly expanded = signal(false);

  /** Só a rotina que é de fato a próxima da sequência ganha destaque; sem ela, a lista inteira aparece. */
  protected readonly featured = computed(() => this.entries().find((entry) => entry.next) ?? null);
  protected readonly continuing = computed(() => {
    const next = this.featured();
    const open = this.activeSession();
    return next !== null && open !== undefined && open.routineId === next.routine.id;
  });
  protected readonly showingAll = computed(() => this.expanded() || this.featured() === null);
  protected readonly hasMore = computed(
    () => this.featured() !== null && this.entries().length > 1,
  );
  protected readonly moreLabel = computed(() => {
    const count = this.entries().length;
    if (this.showingAll()) return $localize`:@@training.routines.show-less:Ver Menos`;
    return $localize`:@@training.routines.show-more-many:Ver Mais ${count}:count: Rotinas`;
  });

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
      parts.push($localize`:@@training.routines.minutes:cerca de ${minutes}:minutes:\u00a0min`);
    }
    return parts.join(' · ');
  }

  /**
   * Abre o treino da rotina e segue para o dia de treino. O treino aberto neste aparelho só é retomado quando é desta
   * mesma rotina; se for de outra, a tela avisa e fica, para ninguém cair num treino que não escolheu. Outro aparelho
   * com treino aberto bloqueia o início, como em Hoje. A escolha do programa semanal que Hoje oferece antes não entra
   * aqui: quem toca no botão da própria rotina já escolheu o que treinar.
   */
  protected async start(routineId: string): Promise<void> {
    if (this.starting()) return;
    this.starting.set(true);
    this.notice.set(null);
    try {
      const result = await this.sessions.start(routineId);
      if (result.status === 'started' || result.status === 'already-active') {
        this.activeSession.set(result.session);
        if (result.session.routineId !== routineId) {
          this.notice.set({ tone: 'warn', text: this.otherOpenText(result.session.routineId) });
          return;
        }
        // Um treino novo nunca herda as trocas do anterior.
        if (result.status === 'started') this.swaps.clear();
        await this.router.navigateByUrl('/treino/sessao');
        return;
      }
      this.notice.set({
        tone: 'warn',
        text:
          result.status === 'open-elsewhere'
            ? $localize`:@@training.routines.start-elsewhere:Há um treino aberto em outro aparelho. Encerre-o em Hoje para começar este.`
            : $localize`:@@training.routines.start-full:O aparelho está sem espaço: o treino não foi aberto.`,
      });
    } catch {
      // Banco local que não abre ou não grava: a pessoa fica na lista, com o botão livre para tentar de novo.
      this.notice.set({
        tone: 'warn',
        text: $localize`:@@training.routines.start-failed:Não foi possível abrir o treino agora. Tente de novo.`,
      });
    } finally {
      this.starting.set(false);
    }
  }

  /** "Há um treino aberto (Treino A)": nomeia a rotina que está em andamento, ou o treino livre. */
  private otherOpenText(openRoutineId: string | null): string {
    const open = this.entries().find((entry) => entry.routine.id === openRoutineId);
    const name = open?.routine.name ?? $localize`:@@training.routines.free-workout:Treino Livre`;
    return $localize`:@@training.routines.start-other:Há um treino aberto: ${name}:name:. Continue ou encerre em Hoje antes de iniciar outro.`;
  }

  protected openTemplates(): void {
    this.notice.set(null);
    this.templatesOpen.set(true);
  }

  protected closeTemplates(): void {
    this.templatesOpen.set(false);
  }

  protected toggleAll(): void {
    this.expanded.update((showing) => !showing);
  }

  protected onCreated(event: TemplateCreated): void {
    const name = event.name;
    const count = event.count;
    const createdText =
      count === 1
        ? $localize`:@@training.templates.done-one:Criamos 1 rotina do modelo ${name}:name:.`
        : $localize`:@@training.templates.done-many:Criamos ${count}:count: rotinas do modelo ${name}:name:.`;
    const text = event.program
      ? $localize`:@@training.templates.model-chosen:Modelo ${name}:name: escolhido. Hoje abre no treino do dia.`
      : event.historical
        ? `${createdText} ${$localize`:@@training.templates.historical-created:Estas rotinas históricas ficaram inativas e não são uma recomendação.`}`
        : event.draft
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
    const [all, alive, sessions, open] = await Promise.all([
      this.routines.all(),
      this.routines.listAll(),
      this.sessions.sessionsBetween(0, Number.MAX_SAFE_INTEGER),
      // Só enfeita o botão: sem leitura do treino aberto, a tela segue e o botão diz "Iniciar".
      this.sessions.activeSession().catch(() => undefined),
    ]);
    this.activeSession.set(open);
    this.entries.set(buildRoutineEntries(all, alive, sessions));
    this.ready.set(true);
  }
}
