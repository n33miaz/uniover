import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { PcPowerOutcome } from '../../../core/modules/pc-availability';
import { PcConfirmSheet } from '../ui/confirm-sheet';
import { PcStore } from '../data/pc-store';
import type { PcFailure } from '../data/pc-failure';
import type { PcPowerAction } from '../data/pc-types';
import { tick } from '../input/haptics';

/** As ações que pedem confirmação numa folha (e a API só aceita com ela): perdem trabalho ou derrubam a conexão. */
type Confirmed = 'SLEEP' | 'HIBERNATE' | 'SHUTDOWN' | 'RESTART' | 'LOGOFF';

/** As duas que abrem a contagem do agente, que dá para cancelar. */
type Countdown = 'SHUTDOWN' | 'RESTART';

/** Quanto tempo o botão de cancelar a contagem fica à vista (a contagem do PC é menor que isto). */
const CANCEL_WINDOW_MS = 5 * 60_000;

interface Action {
  readonly id: Exclude<PcPowerAction, 'CANCEL_SHUTDOWN'>;
  readonly label: string;
  /** O caminho do desenho do ícone (24 x 24, só traço). */
  readonly icon: string;
  /** Vermelho: a ação apaga o que está aberto ou desliga o PC. */
  readonly danger?: boolean;
  /** Só existe com um agente que entende `pc.power.v2`; sem ele a tela nem mostra o botão. */
  readonly needsV2?: boolean;
  /** Só existe num PC com a hibernação ligada (o agente declara `pc.power.hibernate.v1`). */
  readonly needsHibernate?: boolean;
}

interface Sheet {
  readonly title: string;
  readonly text: string;
  readonly confirm: string;
}

/**
 * Energia do PC: bloquear e desligar o monitor valem na hora; suspender, hibernar, desligar, reiniciar e encerrar a sessão
 * pedem confirmação numa folha (e a API só aceita com a confirmação). Desligar e reiniciar usam a contagem do agente,
 * com aviso na tela do PC, e o botão de cancelar fica à vista logo depois, porque essas ações derrubam a conexão e
 * não há como desfazer de outro jeito. Reiniciar, encerrar a sessão, hibernar e desligar o monitor só aparecem para um PC
 * que declarou a capacidade (um agente anterior recusaria o pedido); hibernar, só num PC com a hibernação ligada.
 */
@Component({
  selector: 'app-pc-power-page',
  imports: [PcConfirmSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="actions" [class.tiles]="actions().length > 3">
      @for (item of actions(); track item.id) {
        <button
          type="button"
          class="action"
          [class.danger]="item.danger"
          [attr.data-action]="item.id"
          [disabled]="!store.canSend() || busy()"
          (click)="choose(item.id)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="item.icon" />
          </svg>
          <span>{{ item.label }}</span>
        </button>
      }
    </div>

    @if (countdown(); as kind) {
      <div class="cancel" role="status">
        <p>{{ kind === 'RESTART' ? restartCounting : shutdownCounting }}</p>
        <button
          type="button"
          class="ui-btn"
          [disabled]="!store.canSend() || busy()"
          (click)="cancelCountdown()"
        >
          {{ kind === 'RESTART' ? cancelRestartLabel : cancelShutdownLabel }}
        </button>
      </div>
    }
    @if (message(); as text) {
      <p class="error ui-notice bad" role="alert">{{ text }}</p>
    }

    @if (pending(); as action) {
      <app-pc-confirm-sheet
        [heading]="sheets[action].title"
        [text]="sheetText(action)"
        [confirmLabel]="sheets[action].confirm"
        [busy]="busy()"
        [error]="sheetError()"
        (confirmed)="confirm(action)"
        (closed)="pending.set(null)"
      />
    }
  `,
  styleUrl: './power.page.css',
})
export class PowerPage {
  protected readonly store = inject(PcStore);
  protected readonly pending = signal<Confirmed | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly sheetError = signal<string | null>(null);
  /** O desligamento ou o reinício foi pedido há pouco: mostra o botão que cancela a contagem. */
  protected readonly countdown = signal<Countdown | null>(null);

  private readonly all: readonly Action[] = [
    {
      id: 'LOCK',
      label: $localize`:@@pc.power.lock:Bloquear`,
      icon: 'M8 11V8a4 4 0 0 1 8 0v3M7 11h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z',
    },
    {
      id: 'SLEEP',
      label: $localize`:@@pc.power.sleep:Suspender`,
      icon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
    },
    {
      id: 'SHUTDOWN',
      label: $localize`:@@pc.power.shutdown:Desligar`,
      icon: 'M12 3v8M6.4 6.6a8 8 0 1 0 11.2 0',
      danger: true,
    },
    {
      id: 'HIBERNATE',
      label: $localize`:@@pc.power.hibernate:Hibernar`,
      icon: 'M12 3v10M8.5 9.5 12 13l3.5-3.5M5 17h14M7 21h10',
      needsV2: true,
      needsHibernate: true,
    },
    {
      id: 'MONITOR_OFF',
      label: $localize`:@@pc.power.monitor-off:Desligar o Monitor`,
      icon: 'M3 5h18v11H3zM8 20h8M12 16v4M6 8l12 5',
      needsV2: true,
    },
    {
      id: 'RESTART',
      label: $localize`:@@pc.power.restart:Reiniciar`,
      icon: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
      danger: true,
      needsV2: true,
    },
    {
      id: 'LOGOFF',
      label: $localize`:@@pc.power.logoff:Encerrar Sessão`,
      icon: 'M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9',
      danger: true,
      needsV2: true,
    },
  ];
  protected readonly actions = computed(() =>
    this.all.filter(
      (item) =>
        (!item.needsV2 || this.store.supportsPowerV2()) &&
        (!item.needsHibernate || this.store.supportsHibernate()),
    ),
  );

  protected readonly shutdownCounting = $localize`:@@pc.power.counting:O PC vai desligar. O aviso aparece na tela dele.`;
  protected readonly restartCounting = $localize`:@@pc.power.restart-counting:O PC vai reiniciar. O aviso aparece na tela dele.`;
  protected readonly cancelShutdownLabel = $localize`:@@pc.power.cancel:Cancelar Desligamento`;
  protected readonly cancelRestartLabel = $localize`:@@pc.power.cancel-restart:Cancelar Reinício`;

  protected readonly sheets: Readonly<Record<Confirmed, Sheet>> = {
    SLEEP: {
      title: $localize`:@@pc.power.sleep-title:Suspender o PC?`,
      text: $localize`:@@pc.power.sleep-text:A conexão cai e o PC só volta mexendo nele.`,
      confirm: $localize`:@@pc.power.sleep-confirm:Suspender`,
    },
    HIBERNATE: {
      title: $localize`:@@pc.power.hibernate-title:Hibernar o PC?`,
      text: $localize`:@@pc.power.hibernate-text:O Windows guarda o que está aberto e desliga. A conexão cai e o PC só volta ligando o botão dele.`,
      confirm: $localize`:@@pc.power.hibernate-confirm:Hibernar`,
    },
    SHUTDOWN: {
      title: $localize`:@@pc.power.shutdown-title:Desligar o PC?`,
      text: $localize`:@@pc.power.shutdown-text:O agente espera alguns segundos antes de pedir ao Windows. Dá para cancelar aqui antes do fim.`,
      confirm: $localize`:@@pc.power.shutdown-confirm:Desligar`,
    },
    RESTART: {
      title: $localize`:@@pc.power.restart-title:Reiniciar o PC?`,
      text: $localize`:@@pc.power.restart-text:O agente espera alguns segundos antes de pedir ao Windows. Dá para cancelar aqui antes do fim. O Windows pode pedir para salvar o trabalho aberto. O controle volta quando o Windows abrir de novo.`,
      confirm: $localize`:@@pc.power.restart-confirm:Reiniciar`,
    },
    LOGOFF: {
      title: $localize`:@@pc.power.logoff-title:Encerrar a sessão do Windows?`,
      text: $localize`:@@pc.power.logoff-text:O Windows pode pedir para salvar o trabalho aberto. O controle só volta depois que alguém entrar no Windows de novo.`,
      confirm: $localize`:@@pc.power.logoff-confirm:Encerrar Sessão`,
    },
  };

  /**
   * Sem `pc.power.cancel.v1` (0.77.0) o agente pode ser um de antes da 0.74.2, que agenda `shutdown /t`, e prazo maior que zero
   * implica `/f`: os programas fecham sem pedir para salvar. O caminho sem `/f` veio na 0.74.2 sem capacidade própria, então a
   * ausência é evidência conservadora, não certeza. O cancelamento segue valendo (`shutdown /a`).
   */
  private readonly forcedTexts: Readonly<Record<Countdown, string>> = {
    SHUTDOWN: $localize`:@@pc.power.shutdown-text-forced:Os apps abertos podem fechar sem pedir para salvar. Dá para cancelar aqui antes do fim.`,
    RESTART: $localize`:@@pc.power.restart-text-forced:Os apps abertos podem fechar sem pedir para salvar. Dá para cancelar aqui antes do fim. O controle volta quando o Windows abrir de novo.`,
  };

  /** O texto da folha: o de desligar e reiniciar ressalva o fechamento forçado quando o agente não prova que pede sem forçar. */
  protected sheetText(action: Confirmed): string {
    if ((action === 'SHUTDOWN' || action === 'RESTART') && !this.store.supportsPowerCancel()) {
      return this.forcedTexts[action];
    }
    return this.sheets[action].text;
  }

  private readonly sheet = viewChild(PcConfirmSheet);
  private hideTimer: number | null = null;
  /** O desfecho (pela contagem) que o estado já trazia quando a contagem desta tela começou: só outro diz respeito a ela. */
  private seenOutcome: string | null = null;
  /**
   * A contagem que esta tela mostra, como a API a devolveu: o cancelamento só atinge ela, e só o desfecho dela fecha o botão. Uma
   * API anterior não a devolve, e aí vale o desfecho que não estava lá quando a contagem começou.
   */
  private countdownId: string | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    });
    // A contagem não terminou no pedido (o Windows recusou, ou o agente reiniciou no meio dela): não há mais o que cancelar, e a
    // tela diz o que houve em vez de seguir oferecendo o botão.
    effect(() => {
      const outcome = this.store.powerOutcome();
      if (outcome === null || this.countdown() === null) return;
      if (this.countdownId !== null ? outcome.countdownId !== this.countdownId : outcome.countdownId === this.seenOutcome) {
        return;
      }
      untracked(() => this.countdownEnded(outcome));
    });
  }

  private countdownEnded(outcome: PcPowerOutcome): void {
    this.seenOutcome = outcome.countdownId;
    this.countdown.set(null);
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.message.set(this.outcomeText(outcome));
  }

  private outcomeText(outcome: PcPowerOutcome): string {
    const restart = outcome.action === 'RESTART';
    if (outcome.outcome === 'cancelled') {
      return restart
        ? $localize`:@@pc.power.restart-cancelled-on-pc:O reinício foi cancelado na tela do PC.`
        : $localize`:@@pc.power.shutdown-cancelled-on-pc:O desligamento foi cancelado na tela do PC.`;
    }
    if (outcome.outcome === 'refused') {
      return restart
        ? $localize`:@@pc.power.restart-refused:O Windows recusou reiniciar. O PC segue ligado.`
        : $localize`:@@pc.power.shutdown-refused:O Windows recusou desligar. O PC segue ligado.`;
    }
    return restart
      ? $localize`:@@pc.power.restart-lost:O agente do PC reiniciou no meio da contagem. O PC não vai reiniciar.`
      : $localize`:@@pc.power.shutdown-lost:O agente do PC reiniciou no meio da contagem. O PC não vai desligar.`;
  }

  /** Bloquear e apagar o monitor valem na hora; o resto abre a folha de confirmação. */
  protected async choose(id: Action['id']): Promise<void> {
    tick();
    if (id === 'LOCK' || id === 'MONITOR_OFF') {
      await this.run(id);
      return;
    }
    this.message.set(null);
    this.sheetError.set(null);
    this.pending.set(id);
  }

  protected async confirm(action: Confirmed): Promise<void> {
    if (this.busy()) return;
    if (action === 'SHUTDOWN' || action === 'RESTART') {
      let countdownId: string | null = null;
      const started = await this.send(async () => {
        const result = await this.store.startCountdown(action);
        countdownId = result.countdownId;
        return result.failure;
      });
      if (!started) return;
      this.sheet()?.close();
      this.showCancel(action, countdownId);
      return;
    }
    if (!(await this.run(action, true))) return;
    this.sheet()?.close();
  }

  protected async cancelCountdown(): Promise<void> {
    tick();
    const shown = this.countdownId;
    let gone = false;
    const cancelled = await this.send(async () => {
      const failure = await (shown === null
        ? this.store.power('CANCEL_SHUTDOWN', false)
        : this.store.power('CANCEL_SHUTDOWN', false, shown));
      gone = failure?.kind === 'countdown-gone';
      return failure;
    });
    // A contagem desta tela já acabou: não há mais o que cancelar (a mensagem diz que nada foi cancelado).
    if (cancelled || gone) this.countdown.set(null);
  }

  private run(action: PcPowerAction, confirmed = false): Promise<boolean> {
    return this.send(() => this.store.power(action, confirmed));
  }

  private async send(call: () => Promise<PcFailure | null>): Promise<boolean> {
    this.busy.set(true);
    this.message.set(null);
    this.sheetError.set(null);
    const failure = await call();
    this.busy.set(false);
    if (failure) {
      // A falha aparece onde a pessoa está olhando: dentro da folha, se ela estiver aberta.
      if (this.pending()) this.sheetError.set(failure.message);
      else this.message.set(failure.message);
      return false;
    }
    return true;
  }

  private showCancel(kind: Countdown, countdownId: string | null): void {
    this.seenOutcome = untracked(() => this.store.powerOutcome())?.countdownId ?? null;
    this.countdownId = countdownId;
    this.countdown.set(kind);
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.countdown.set(null), CANCEL_WINDOW_MS);
  }
}
