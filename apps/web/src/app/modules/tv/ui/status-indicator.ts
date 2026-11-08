import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TvAccess } from '../data/tv-access';
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

function prefersLessMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Folga mínima (px) entre o painelzinho e a borda da tela. */
const PANEL_MARGIN_PX = 12;

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
  private readonly access = inject(TvAccess);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** Quantos comandos já tinham saído quando o ponto nasceu: só os de depois o fazem piscar. */
  private readonly sentAtStart = this.store.sentCount();
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');

  protected readonly panelId = `tv-status-panel-${nextIndicatorId++}`;
  protected readonly titleId = `${this.panelId}-title`;
  protected readonly open = signal(false);
  protected readonly busy = signal(false);

  protected readonly indicator = computed(() =>
    deriveIndicator(this.store.status(), this.store.watchdog()?.kind ?? null),
  );
  /**
   * A piscada de quando um botão do controle manda um comando. `a` e `b` se alternam a cada comando: o CSS tem uma
   * animação para cada, então trocar de uma para a outra a reinicia mesmo com toques seguidos. Quem pediu menos
   * movimento não vê piscada nenhuma (lido a cada comando, que é quando este cálculo roda de novo).
   */
  protected readonly sent = computed<'a' | 'b' | null>(() => {
    const count = this.store.sentCount() - this.sentAtStart;
    if (count <= 0 || prefersLessMotion()) return null;
    return count % 2 === 1 ? 'a' : 'b';
  });
  protected readonly phase = computed(() => indicatorPhase(this.indicator()));
  protected readonly text = computed(() =>
    indicatorText(
      this.indicator(),
      this.store.hibernateMinutes,
      this.access.control(),
      this.store.agentOffText(),
    ),
  );

  /**
   * A ação que o painelzinho oferece. "Acordar o controle" é um comando (`tv:control`): para quem só vê a TV ela não
   * aparece. "Tentar de novo" só lê o estado e fica para todos.
   */
  protected readonly action = computed<TvIndicatorAction | null>(() => {
    const action = this.text().action;
    return action === 'wake' && !this.access.control() ? null : action;
  });

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
    const opening = !this.open();
    this.open.set(opening);
    if (opening) afterNextRender(() => this.keepOnScreen(), { injector: this.injector });
  }

  /**
   * O painelzinho é centrado no ponto, e o ponto fica junto do fim do nome (não no meio da tela): se o painel passaria
   * da borda, desliza para dentro, sem sair da largura da tela nem criar rolagem.
   */
  private keepOnScreen(): void {
    const panel = this.host.nativeElement.querySelector<HTMLElement>('.panel');
    if (!panel) return;
    const { left, right, width } = panel.getBoundingClientRect();
    const view = panel.ownerDocument.documentElement.clientWidth;
    if (width === 0 || view === 0) return;
    const shift =
      left < PANEL_MARGIN_PX
        ? PANEL_MARGIN_PX - left
        : right > view - PANEL_MARGIN_PX
          ? view - PANEL_MARGIN_PX - right
          : 0;
    panel.style.setProperty('--shift', shift + 'px');
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
