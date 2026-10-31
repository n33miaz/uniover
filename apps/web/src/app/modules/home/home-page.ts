import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { canUseModule } from '../../core/auth/guest-home';
import { ModulePrefs, WidgetPref } from '../../core/modules/module-prefs';
import { ModuleDefinition, ModuleRegistry } from '../../core/modules/module-registry';
import { TV_LIVRE_ENTRY } from '../../core/modules/tv-livre-entry.port';
import { SessionState } from '../../core/session/session-state';
import { HomeStatusPort } from '../../core/status/home-status.port';
import { ClockService } from '../../core/time/clock.service';
import { HomeEditSheet } from './home-edit-sheet';
import { HomeGlyph } from './home-glyph';
import { ModuleAppIcon } from './module-app-icon';
import { HomeSoonBadge } from './home-soon-badge';
import { Skeleton } from '../../shared/ui/skeleton/skeleton';

type ChipTone = 'ok' | 'warn' | 'connecting';
type DayPart = 'morning' | 'afternoon' | 'evening';

interface InfoChip {
  readonly id: string;
  readonly label: string;
  readonly tone: ChipTone;
}

/** Planejados que a Início do convidado apresenta no fim da grade, na ordem escolhida. */
const GUEST_PLANNED_MODULES: readonly string[] = ['pc', 'network', 'backup'];

/** Parte do dia: manhã até 11h59, tarde até 17h59, noite no resto (a mesma régua da saudação). */
export function dayPartFor(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** Só o primeiro nome, para a saudação ("Neemias Cormino Manso" vira "Neemias"); `null` se não há nome. */
export function firstNameOf(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** Saudação pela hora do dia: manhã até 11h59, tarde até 17h59, noite no resto. */
export function greetingFor(hour: number): string {
  switch (dayPartFor(hour)) {
    case 'morning':
      return $localize`:@@home.greeting.morning:Bom dia`;
    case 'afternoon':
      return $localize`:@@home.greeting.afternoon:Boa tarde`;
    default:
      return $localize`:@@home.greeting.evening:Boa noite`;
  }
}

/**
 * Início: saudação com data e hora, estado discreto do agente e um bloco por módulo, que o usuário
 * reordena e redimensiona.
 */
@Component({
  selector: 'app-home-page',
  imports: [RouterLink, HomeGlyph, HomeEditSheet, ModuleAppIcon, HomeSoonBadge, Skeleton],
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
})
export class HomePage {
  private readonly clock = inject(ClockService);
  private readonly statusPort = inject(HomeStatusPort);
  private readonly status = this.statusPort.status;
  protected readonly loading = this.statusPort.loading;
  private readonly prefs = inject(ModulePrefs);
  private readonly session = inject(SessionState);
  protected readonly registry = inject(ModuleRegistry);
  private readonly livreEntry = inject(TV_LIVRE_ENTRY);

  private readonly editButton = viewChild<ElementRef<HTMLButtonElement>>('editButton');

  constructor() {
    // O estado da casa só é consultado enquanto a Início está na tela: o acompanhamento acaba com o componente.
    inject(DestroyRef).onDestroy(this.statusPort.watch());
    // O cartão do TV Livre depende de a TV atual declarar a capacidade: a lista de TVs é renovada ao abrir a Início.
    this.livreEntry.refresh();
  }

  protected readonly editing = signal(false);
  protected readonly isGuest = this.session.isGuest;
  /** Convidado vê os módulos liberados e os três planejados reservados para esta grade. */
  protected readonly widgets = computed(() => {
    const visible = this.prefs
      .visible()
      .filter((widget) => this.canSeeModule(widget.definition.id));
    return this.isGuest()
      ? visible.sort((first, second) => this.guestOrder(first.definition.id, second.definition.id))
      : visible;
  });
  /** A folha de edição também não revela nem altera módulos fora do acesso da conta. */
  protected readonly allWidgets = computed(() => {
    const widgets = this.prefs.widgets().filter((widget) => this.canSeeModule(widget.id));
    return this.isGuest()
      ? widgets.sort((first, second) => this.guestOrder(first.id, second.id))
      : widgets;
  });

  protected readonly dayPart = computed(() => dayPartFor(this.clock.now().getHours()));

  protected readonly greeting = computed(() => {
    const base = greetingFor(this.clock.now().getHours());
    const name = firstNameOf(this.status().userName);
    return name ? `${base}, ${name}` : base;
  });

  protected readonly time = computed(() =>
    new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
      this.clock.now(),
    ),
  );

  protected readonly dateLabel = computed(() =>
    new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(
      this.clock.now(),
    ),
  );

  /**
   * Estado curto do agente DESTA conta: sem agente vinculado ou sem estado confirmado não há ponto (nem reserva de espaço
   * que sugira um computador pareado). Só a leitura em andamento, ainda sem estado, mostra a bolinha pulsando.
   */
  protected readonly agentIndicator = computed<InfoChip | null>(() => {
    const status = this.status();
    if (status.agentLinked === false) return null;
    if (this.loading() && status.agent === 'unknown') {
      return {
        id: 'agent',
        label: $localize`:@@home.agent-connecting:Conectando ao agente`,
        tone: 'connecting',
      };
    }
    if (status.agent === 'online')
      return { id: 'agent', label: $localize`:@@home.chip.agent-on:Agente ligado`, tone: 'ok' };
    if (status.serviceDown)
      return {
        id: 'agent',
        label: $localize`:@@home.agent-unresponsive:Agente sem resposta`,
        tone: 'warn',
      };
    if (status.agent === 'offline')
      return {
        id: 'agent',
        label: $localize`:@@home.chip.agent-off:Agente desligado`,
        tone: 'warn',
      };
    return null;
  });

  /**
   * A bolinha do agente aparece para quem usa a TV, dono ou convidado: o estado lido é o do agente da TV da própria conta,
   * nunca o de outra pessoa (a Início não mostra avisos sobre computadores alheios).
   */
  protected readonly canSeeAgent = computed(() => this.canSeeModule('tv'));

  /** Nome do link do cartão: o nome visível primeiro e a ação depois, para o leitor de tela dizer o que acontece. */
  protected linkLabel(module: ModuleDefinition): string {
    return module.actionLabel
      ? $localize`:@@home.module-link:${module.title}:title:: ${module.actionLabel}:action:`
      : module.title;
  }

  protected openEditor(): void {
    this.editing.set(true);
  }

  protected applyEdit(next: readonly WidgetPref[]): void {
    this.prefs.apply(next);
    this.closeEditor();
  }

  protected closeEditor(): void {
    this.editing.set(false);
    // O diálogo some do DOM; devolve o foco para quem o abriu.
    queueMicrotask(() => this.editButton()?.nativeElement.focus());
  }

  private canSeeModule(id: string): boolean {
    // O TV Livre é só do dono e só existe para a TV que o suporta: some para o convidado e para a TV sem a capacidade
    // (a Samsung, por exemplo), na grade e na folha de edição.
    if (id === 'tv-livre') return !this.session.isGuest() && this.livreEntry.available();
    if (!this.session.isGuest()) return true;
    if (this.registry.find(id)?.status === 'soon') {
      return GUEST_PLANNED_MODULES.includes(id);
    }
    const permissions = this.session.knownPermissions();
    return permissions !== null && canUseModule('guest', permissions, id);
  }

  /** Módulos liberados vêm primeiro; os três planejados ficam no fim, sempre na mesma ordem. */
  private guestOrder(first: string, second: string): number {
    const rank = (id: string) => {
      const planned = GUEST_PLANNED_MODULES.indexOf(id);
      return planned < 0 ? -1 : planned;
    };
    const firstRank = rank(first);
    const secondRank = rank(second);
    if (firstRank < 0 && secondRank < 0) return 0;
    if (firstRank < 0) return -1;
    if (secondRank < 0) return 1;
    return firstRank - secondRank;
  }
}
