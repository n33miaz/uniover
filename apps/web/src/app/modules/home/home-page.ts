import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { canUseModule } from '../../core/auth/guest-home';
import { ModulePrefs, WidgetPref } from '../../core/modules/module-prefs';
import { ModuleDefinition, ModuleRegistry, ModuleStatus } from '../../core/modules/module-registry';
import { SessionState } from '../../core/session/session-state';
import { HomeStatusPort } from '../../core/status/home-status.port';
import { ClockService } from '../../core/time/clock.service';
import { HomeEditSheet } from './home-edit-sheet';
import { HomeGlyph } from './home-glyph';
import { HomeHero } from './home-hero';
import { HomePcCard } from './home-pc-card';
import { ModuleAppIcon } from './module-app-icon';
import { HomeSoonBadge } from './home-soon-badge';

type ChipTone = 'ok' | 'warn' | 'connecting';
type DayPart = 'morning' | 'afternoon' | 'evening';

interface InfoChip {
  readonly id: string;
  readonly label: string;
  readonly tone: ChipTone;
}

/** O que a Início sabe de um módulo agora; `pending` é o cartão do PC antes de a API (ou a lembrança da conta) dizer. */
type CardState = ModuleStatus | 'pending';

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
  imports: [RouterLink, HomeGlyph, HomeHero, HomeEditSheet, ModuleAppIcon, HomeSoonBadge],
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
  private readonly pcCard = inject(HomePcCard);
  protected readonly registry = inject(ModuleRegistry);

  private readonly editButton = viewChild<ElementRef<HTMLButtonElement>>('editButton');

  constructor() {
    // O estado da casa só é consultado enquanto a Início está na tela: o acompanhamento acaba com o componente.
    inject(DestroyRef).onDestroy(this.statusPort.watch());
    // O cartão do Controle do PC só deixa de ser "Em Breve" quando a casa tem um computador com o controle ligado. Só quem
    // pode usar o módulo pergunta: para as outras contas a API recusaria, e o cartão segue como planejado. Quem ganha a
    // permissão depois (a lista chega com a sessão) também pergunta, na hora.
    effect(() => {
      if (this.canUsePc()) untracked(() => void this.pcCard.refresh());
      else untracked(() => this.pcCard.forget());
    });
  }

  protected readonly editing = signal(false);
  protected readonly isGuest = this.session.isGuest;
  private readonly canUsePc = computed(() =>
    canUseModule(this.session.role(), this.session.knownPermissions(), 'pc'),
  );
  /**
   * Os módulos da grade: os que já funcionam primeiro (cada grupo na ordem que a pessoa escolheu) e, depois, só os "em breve"
   * que o administrador liberou para a Início. Quem ainda não se sabe como está (o PC, antes da primeira resposta) fica de
   * fora: assim o cartão nunca nasce com uma cara e muda para outra.
   */
  protected readonly widgets = computed(() => {
    const visible = this.prefs
      .visible()
      .filter((widget) => this.canSeeModule(widget.definition.id));
    const active = visible.filter((widget) => this.stateOf(widget.definition) === 'available');
    return [...active, ...visible.filter((widget) => !active.includes(widget))];
  });
  /** A folha de edição também não revela nem altera módulos fora do acesso da conta. */
  protected readonly allWidgets = computed(() => {
    const widgets = this.prefs.widgets().filter((widget) => this.canSeeModule(widget.id));
    const active = widgets.filter((widget) => this.isActive(widget.id));
    return [...active, ...widgets.filter((widget) => !active.includes(widget))];
  });
  /** Os módulos da folha que ainda são "em breve" (o ícone fica cinza, como no cartão). */
  protected readonly plannedIds = computed(
    () =>
      new Set(
        this.registry.modules
          .filter((module) => this.stateOf(module) !== 'available')
          .map((module) => module.id),
      ),
  );

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
        label: $localize`:@@home.agent-connecting:Conectando ao computador`,
        tone: 'connecting',
      };
    }
    if (status.agent === 'online')
      return { id: 'agent', label: $localize`:@@home.chip.agent-on:Computador ligado`, tone: 'ok' };
    if (status.serviceDown)
      return {
        id: 'agent',
        label: $localize`:@@home.agent-unresponsive:Computador sem resposta`,
        tone: 'warn',
      };
    if (status.agent === 'offline')
      return {
        id: 'agent',
        label: $localize`:@@home.chip.agent-off:Computador desligado`,
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

  /** O estado do cartão: o do catálogo, exceto o do PC, que depende da conta (ver `HomePcCard`). */
  protected stateOf(module: ModuleDefinition): CardState {
    if (module.liveWith !== 'pc-agent') return this.registry.statusOf(module);
    if (!this.canUsePc()) return 'soon';
    const available = this.pcCard.available();
    return available === null ? 'pending' : available ? 'available' : 'soon';
  }

  /** Caminho do cartão, ou `null` quando ele não abre nada (planejado) ou ainda não se sabe. */
  protected pathOf(module: ModuleDefinition): string | null {
    if (this.stateOf(module) !== 'available') return null;
    return module.route ?? (module.slug ? `/${module.slug}` : null);
  }

  private isActive(id: string): boolean {
    const module = this.registry.find(id);
    return module !== undefined && this.stateOf(module) === 'available';
  }

  /**
   * O que a conta vê: o módulo ainda sem estado conhecido nunca; o "em breve" só quando o administrador o liberou; o que
   * já funciona, para o dono sempre e para o convidado quando as permissões dele trazem o módulo.
   */
  private canSeeModule(id: string): boolean {
    const module = this.registry.find(id);
    if (!module) return false;
    const state = this.stateOf(module);
    if (state === 'pending') return false;
    if (state === 'soon') return this.prefs.soonVisible().includes(id);
    if (!this.session.isGuest()) return true;
    const permissions = this.session.knownPermissions();
    return permissions !== null && canUseModule('guest', permissions, id);
  }
}
