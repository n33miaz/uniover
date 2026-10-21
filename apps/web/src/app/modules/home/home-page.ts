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
import { ModulePrefs, WidgetPref } from '../../core/modules/module-prefs';
import { ModuleDefinition, ModuleRegistry } from '../../core/modules/module-registry';
import { HomeStatusPort } from '../../core/status/home-status.port';
import { ClockService } from '../../core/time/clock.service';
import { HomeEditSheet } from './home-edit-sheet';
import { HomeGlyph, HomeGlyphName, moduleGlyph } from './home-glyph';

type ChipTone = 'neutral' | 'ok' | 'warn';
type DayPart = 'morning' | 'afternoon' | 'evening';

interface InfoChip {
  readonly id: string;
  readonly label: string;
  readonly tone: ChipTone;
}

interface Shortcut {
  readonly id: string;
  readonly link: string;
  readonly glyph: HomeGlyphName;
  readonly title: string;
  readonly hint: string;
}

/** Parte do dia: manhã até 11h59, tarde até 17h59, noite no resto (a mesma régua da saudação). */
export function dayPartFor(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
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
 * Início: saudação com data e hora, faixa de informações, atalhos e um bloco por módulo, que o usuário
 * reordena e redimensiona.
 */
@Component({
  selector: 'app-home-page',
  imports: [RouterLink, HomeGlyph, HomeEditSheet],
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
})
export class HomePage {
  private readonly clock = inject(ClockService);
  private readonly statusPort = inject(HomeStatusPort);
  private readonly status = this.statusPort.status;
  private readonly prefs = inject(ModulePrefs);
  protected readonly registry = inject(ModuleRegistry);

  private readonly editButton = viewChild<ElementRef<HTMLButtonElement>>('editButton');

  constructor() {
    // O estado da casa só é consultado enquanto a Início está na tela: o acompanhamento acaba com o componente.
    inject(DestroyRef).onDestroy(this.statusPort.watch());
  }

  protected readonly editing = signal(false);
  /**
   * Blocos na ordem escolhida, já com a largura de fato: "Largo" ocupa a linha toda; um "Pequeno" que ficaria
   * sozinho na linha (porque o próximo é largo, ou porque é o último) também a ocupa, sem deixar buraco.
   */
  protected readonly widgets = computed(() => {
    const visible = this.prefs.visible();
    let column = 0;
    return visible.map((widget, index) => {
      let full = widget.size === 'wide';
      if (full) {
        column = 0;
      } else if (column === 0) {
        const next = visible[index + 1];
        full = !next || next.size === 'wide';
        column = full ? 0 : 1;
      } else {
        column = 0;
      }
      return { ...widget, full };
    });
  });
  protected readonly allWidgets = this.prefs.widgets;

  protected readonly dayPart = computed(() => dayPartFor(this.clock.now().getHours()));

  protected readonly greeting = computed(() => {
    const base = greetingFor(this.clock.now().getHours());
    const name = this.status().userName;
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

  /** Atalhos para o que mais se procura fora dos módulos; só rotas que existem hoje. */
  protected readonly shortcuts: readonly Shortcut[] = [
    {
      id: 'devices',
      link: '/ajustes/aparelhos',
      glyph: 'laptop',
      title: $localize`:@@home.shortcut.devices:Aparelhos`,
      hint: $localize`:@@home.shortcut.devices-hint:Parear o PC de casa`,
    },
    {
      id: 'settings',
      link: '/ajustes',
      glyph: 'sliders',
      title: $localize`:@@home.shortcut.settings:Ajustes`,
      hint: $localize`:@@home.shortcut.settings-hint:Conta, tema e convidados`,
    },
  ];

  /** Faixa de informações úteis. Sem dado real mostra "sem dados" em vez de inventar um estado. */
  protected readonly chips = computed<readonly InfoChip[]>(() => {
    const status = this.status();
    const agent: InfoChip =
      status.agent === 'online'
        ? { id: 'agent', label: $localize`:@@home.chip.agent-on:Agente ligado`, tone: 'ok' }
        : status.agent === 'offline'
          ? { id: 'agent', label: $localize`:@@home.chip.agent-off:Agente desligado`, tone: 'warn' }
          : {
              id: 'agent',
              label: $localize`:@@home.chip.agent-unknown:Agente sem dados`,
              tone: 'neutral',
            };
    const watcher: InfoChip =
      status.watcher === 'ok'
        ? { id: 'watcher', label: $localize`:@@home.chip.watcher-ok:Vigia sem avisos`, tone: 'ok' }
        : status.watcher === 'alert'
          ? {
              id: 'watcher',
              label: $localize`:@@home.chip.watcher-alert:Vigia com aviso`,
              tone: 'warn',
            }
          : {
              id: 'watcher',
              label: $localize`:@@home.chip.watcher-unknown:Vigia sem dados`,
              tone: 'neutral',
            };
    const chips = [agent, watcher];
    if (status.serviceDown) {
      chips.push({
        id: 'service',
        label: $localize`:@@home.chip.service-down:Serviço fora do ar`,
        tone: 'warn',
      });
    }
    return chips;
  });

  protected glyphFor(module: ModuleDefinition): HomeGlyphName {
    return moduleGlyph(module.icon);
  }

  /**
   * Estado ao vivo do módulo, só quando já existe no que a Início conhece: o controle da TV depende do agente.
   * Sem dado (agente desconhecido) não mostra nada, em vez de inventar.
   */
  protected live(module: ModuleDefinition): InfoChip | null {
    if (module.id !== 'tv') return null;
    switch (this.status().agent) {
      case 'online':
        return {
          id: 'tv-live',
          label: $localize`:@@home.live.tv-on:Pronto para usar`,
          tone: 'ok',
        };
      case 'offline':
        return {
          id: 'tv-live',
          label: $localize`:@@home.live.tv-off:Sem agente em casa`,
          tone: 'warn',
        };
      default:
        return null;
    }
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
}
