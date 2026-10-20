import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import {
  TvIndicatorAction,
  deriveIndicator,
  indicatorPhase,
  indicatorText,
  statusLabel,
} from '../data/tv-status';
import { TvStore } from '../data/tv-store';
import { StatusDot } from './status-dot';

let nextIndicatorId = 0;

/**
 * Indicador de estado do cabeçalho: um ponto que é um botão (alvo de 44 px). Tocar abre um painelzinho, sem fundo
 * escurecido, com o nome do estado, uma frase do que significa, a hora da última atualização e a ação possível
 * ("Acordar o controle" quando dorme, "Tentar de novo" quando falta o agente). Fecha com Esc, com toque fora e
 * ao rodar a ação; o foco volta ao ponto. É um padrão de divulgação (`aria-expanded`), e não um modal: o resto da
 * tela continua à mão.
 */
@Component({
  selector: 'app-status-indicator',
  imports: [StatusDot],
  templateUrl: './status-indicator.html',
  styleUrl: './status-indicator.css',
  host: {
    '(document:pointerdown)': 'onOutside($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class StatusIndicator {
  protected readonly store = inject(TvStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');

  protected readonly panelId = `tv-status-panel-${nextIndicatorId++}`;
  protected readonly titleId = `${this.panelId}-title`;
  protected readonly open = signal(false);
  protected readonly busy = signal(false);

  protected readonly indicator = computed(() =>
    deriveIndicator(this.store.status(), this.store.watchdog()?.kind ?? null),
  );
  protected readonly phase = computed(() => indicatorPhase(this.indicator()));
  protected readonly text = computed(() =>
    indicatorText(this.indicator(), this.store.hibernateMinutes),
  );

  protected readonly triggerLabel = computed(() => {
    const title = this.text().title;
    return $localize`:@@tv.indicator.trigger:Estado do controle: ${title}:title:`;
  });

  /**
   * Hora da última atualização. Sem rede, o último estado conhecido vem junto ("visto às 14:02: controle
   * dormindo"), porque o que se vê já é antigo.
   */
  protected readonly seen = computed<string | null>(() => {
    const time = this.store.seenAtText();
    if (!time) return null;
    if (this.store.status() === 'offline') {
      const known = this.store.lastKnownStatus();
      if (known !== null) {
        const label = statusLabel(known);
        return $localize`:@@tv.indicator.last-seen:Visto às ${time}:time: · ${label}:label:`;
      }
    }
    return $localize`:@@tv.indicator.updated:Atualizado às ${time}:time:`;
  });

  /** Fatos extras que o store já sabe: o que o vigia fez e se o fluxo está reconectando. */
  protected readonly notes = computed(() => {
    const notes: string[] = [];
    const watchdog = this.store.watchdogNote();
    if (watchdog) notes.push(watchdog);
    if (this.store.streamStatus() === 'reconnecting' && this.store.link() === 'ok') {
      notes.push($localize`:@@tv.indicator.reconnecting:Reconectando ao servidor…`);
    }
    return notes;
  });

  protected toggle(): void {
    this.open.update((value) => !value);
  }

  protected close(returnFocus: boolean): void {
    if (!this.open()) return;
    this.open.set(false);
    if (returnFocus) this.trigger().nativeElement.focus({ preventScroll: true });
  }

  protected onEscape(): void {
    this.close(true);
  }

  /** Toque fora do ponto e do painelzinho fecha; o foco fica onde o toque o pôs. */
  protected onOutside(event: Event): void {
    if (!this.open()) return;
    if (this.host.nativeElement.contains(event.target as Node)) return;
    this.close(false);
  }

  protected async run(action: TvIndicatorAction): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (action === 'retry') await this.store.refresh();
      await this.store.wake();
    } finally {
      this.busy.set(false);
      this.close(true);
    }
  }
}
