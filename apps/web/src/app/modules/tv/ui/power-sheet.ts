import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { TvPowerSchedule } from '../data/tv-api';
import { TvStore } from '../data/tv-store';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';
import { leaveSheet } from './sheet-motion';

/**
 * Folha "Desligar a TV?": sobe de baixo, sem botão de fechar (a saída é "Cancelar" ou Esc). Desligar é a única
 * ação perigosa do controle, porque sem o emissor infravermelho a TV só volta com o controle original. Por decisão
 * do dono a confirmação é só esta folha (sem passkey). "Desligar" é a ação principal (grande, destrutiva); agendar é a
 * segunda opção, com tempos prontos (15 min, 30 min, 1 h, 2 h) e "Personalizar" para escolher a hora; com um
 * agendamento valendo a folha mostra "Desliga às HH:MM" e o tempo que falta, e permite cancelá-lo. O foco começa em
 * "Cancelar", nunca na ação destrutiva. Se o pedido falhar, o motivo aparece aqui dentro e a folha
 * continua aberta; se der certo, ela fecha e o aviso fica na tela. A entrada e a saída são suaves (CSS); o `closed`
 * só sai depois da saída, para a página não desmontar a folha no meio dela.
 */
@Component({
  selector: 'app-power-sheet',
  templateUrl: './power-sheet.html',
  styleUrl: './power-sheet.css',
})
export class PowerSheet {
  protected readonly store = inject(TvStore);
  private readonly destroy = inject(DestroyRef);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly closeButton = viewChild.required<ElementRef<HTMLButtonElement>>('closeButton');
  private opener: Element | null = null;

  readonly closed = output<void>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly chosen = signal<Date | null>(null);
  /** O tempo pronto escolhido (em minutos), ou "personalizar" (o horário do dia), ou nada. */
  protected readonly selected = signal<number | 'custom' | null>(null);
  /** Os tempos prontos do agendamento. */
  protected readonly chips: readonly { readonly minutes: number; readonly label: string }[] = [
    { minutes: 15, label: $localize`:@@tv.power.schedule.quarter-hour:15 min` },
    { minutes: 30, label: $localize`:@@tv.power.schedule.half-hour:30 min` },
    { minutes: 60, label: $localize`:@@tv.power.schedule.one-hour:1 h` },
    { minutes: 120, label: $localize`:@@tv.power.schedule.two-hours:2 h` },
  ];
  /** O relógio da folha: o "em 25 min" se renova com a leitura periódica do agendamento. */
  private readonly now = signal(Date.now());
  protected readonly dayTime = signal('22:00');
  protected readonly zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** A saída já começou: nem um segundo toque nem um segundo pedido valem mais. */
  private leaving = false;

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha (começa em "Cancelar"), deixa o resto inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      this.opener = document.activeElement;
      dialog.showModal();
      // A ação principal é destrutiva: o foco entra em "Cancelar" (o primeiro do documento seria o "Desligar").
      this.closeButton().nativeElement.focus({ preventScroll: true });
      // O fundo escurecido é o próprio <dialog>; só fecha se o toque começou e terminou fora da folha.
      onDialogBackdropClick(dialog, () => this.cancel());
      void this.store.refreshPowerSchedule();
      // A folha pode ficar aberta no disparo; a leitura periódica traz o desfecho sem reenviar comando.
      const poll = window.setInterval(() => {
        this.now.set(Date.now());
        if (this.store.powerSchedule()) void this.store.refreshPowerSchedule();
      }, 15_000);
      this.destroy.onDestroy(() => window.clearInterval(poll));
    });
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (!this.busy()) this.leave();
  }

  protected async confirm(): Promise<void> {
    if (this.busy() || this.leaving) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const failure = await this.store.powerOff();
      if (failure) {
        this.error.set(failure.message);
        return;
      }
      this.leave();
    } finally {
      // Na saída os botões seguem travados: a folha está sumindo e não pode pedir de novo.
      if (!this.leaving) this.busy.set(false);
    }
  }

  protected chooseMinutes(minutes: number): void {
    this.error.set(null);
    this.selected.set(minutes);
    this.chosen.set(new Date(Date.now() + minutes * 60_000));
  }

  /** "Personalizar": mostra o campo do horário do dia e já propõe o horário que ele traz. */
  protected chooseCustom(): void {
    this.error.set(null);
    this.selected.set('custom');
    this.chooseDayTime();
  }

  /** "Desliga às 21:40" do agendamento que vale: só a hora no dia de hoje; com a data quando é outro dia. */
  protected activeTime(active: TvPowerSchedule): string {
    const due = new Date(active.dueAtUtc);
    const sameDay = due.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat('pt-BR', {
      ...(sameDay ? {} : { dateStyle: 'short' as const }),
      timeStyle: 'short',
      timeZone: active.timeZone,
    }).format(due);
  }

  /** O tempo que falta para o desligamento agendado ("em 25 min", "em 1 h 5 min"); vazio se já passou. */
  protected readonly remaining = computed<string | null>(() => {
    const active = this.store.powerSchedule();
    if (!active) return null;
    const minutes = Math.round((new Date(active.dueAtUtc).getTime() - this.now()) / 60_000);
    if (minutes <= 0) return null;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return $localize`:@@tv.power.schedule.in-minutes:em ${minutes}:minutes: min`;
    return rest === 0
      ? $localize`:@@tv.power.schedule.in-hours:em ${hours}:hours: h`
      : $localize`:@@tv.power.schedule.in-hours-minutes:em ${hours}:hours: h ${rest}:minutes: min`;
  });

  /** Só a hora (HH:MM) de um instante, no fuso do aparelho. */
  protected clock(date: Date): string {
    return new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' }).format(date);
  }

  protected chooseDayTime(): void {
    const [hours, minutes] = this.dayTime().split(':').map(Number);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return;
    const next = new Date();
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    this.chosen.set(next);
  }

  protected updateDayTime(event: Event): void {
    this.dayTime.set((event.target as HTMLInputElement).value);
    this.chooseDayTime();
  }

  protected localTime(date: Date | string, timeZone = this.zone): string {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(date));
  }

  protected lastResult(result: string | null): string {
    switch (result) {
      case 'off':
        return $localize`:@@tv.power.schedule.result-off:TV desligada`;
      case 'already_off':
        return $localize`:@@tv.power.schedule.result-already-off:TV já desligada`;
      case 'offline':
        return $localize`:@@tv.power.schedule.result-offline:Agente offline`;
      case 'unsupported':
        return $localize`:@@tv.power.schedule.result-unsupported:Agente sem suporte`;
      case 'uncertain':
        return $localize`:@@tv.power.schedule.result-uncertain:Estado incerto`;
      case 'failed':
        return $localize`:@@tv.power.schedule.result-failed:Falha ao desligar`;
      case 'tv_changed':
        return $localize`:@@tv.power.schedule.result-tv-changed:Cancelado: a TV mudou de agente`;
      case 'permission_removed':
        return $localize`:@@tv.power.schedule.result-permission:Cancelado: acesso retirado`;
      case 'agent_revoked':
        return $localize`:@@tv.power.schedule.result-agent-revoked:Cancelado: agente revogado`;
      default:
        return $localize`:@@tv.power.schedule.result-cancelled:Agendamento cancelado`;
    }
  }

  protected async saveSchedule(): Promise<void> {
    const chosen = this.chosen();
    if (!chosen || this.busy() || this.leaving) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const failure = await this.store.savePowerSchedule(chosen.toISOString(), this.zone);
      if (failure) this.error.set(failure.message);
      else {
        this.chosen.set(null);
        this.selected.set(null);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async cancelSchedule(): Promise<void> {
    if (this.busy() || this.leaving) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const failure = await this.store.cancelPowerSchedule();
      if (failure) this.error.set(failure.message);
    } finally {
      this.busy.set(false);
    }
  }

  private leave(): void {
    this.leaving = true;
    const dialog = this.dialog().nativeElement;
    leaveSheet(dialog, () => {
      closeDialog(dialog);
      restoreDialogFocus(this.opener);
      this.closed.emit();
    });
  }
}
