import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ModulePrefs, WidgetPref } from '../../core/modules/module-prefs';
import { ModuleRegistry } from '../../core/modules/module-registry';
import { HomeStatusPort } from '../../core/status/home-status.port';
import { ClockService } from '../../core/time/clock.service';
import { Icon } from '../../shared/ui/icon/icon';
import { HomeEditSheet } from './home-edit-sheet';

type ChipTone = 'neutral' | 'ok' | 'warn';

interface InfoChip {
  readonly id: string;
  readonly label: string;
  readonly tone: ChipTone;
}

/** Saudação pela hora do dia: manhã até 11h59, tarde até 17h59, noite no resto. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return $localize`:@@home.greeting.morning:Bom dia`;
  if (hour >= 12 && hour < 18) return $localize`:@@home.greeting.afternoon:Boa tarde`;
  return $localize`:@@home.greeting.evening:Boa noite`;
}

/** Início: saudação, faixa de informações e um bloco por módulo, que o usuário reordena e redimensiona. */
@Component({
  selector: 'app-home-page',
  imports: [RouterLink, Icon, HomeEditSheet],
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
})
export class HomePage {
  private readonly clock = inject(ClockService);
  private readonly status = inject(HomeStatusPort).status;
  private readonly prefs = inject(ModulePrefs);
  protected readonly registry = inject(ModuleRegistry);

  private readonly editButton = viewChild<ElementRef<HTMLButtonElement>>('editButton');

  protected readonly editing = signal(false);
  protected readonly widgets = this.prefs.visible;
  protected readonly allWidgets = this.prefs.widgets;

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
