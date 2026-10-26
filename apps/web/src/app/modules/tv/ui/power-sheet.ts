import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
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
 * do dono a confirmação é só esta folha (sem passkey). Se o pedido falhar, o motivo aparece aqui dentro e a folha
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
  private opener: Element | null = null;

  readonly closed = output<void>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly chosen = signal<Date | null>(null);
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
      // O fundo escurecido é o próprio <dialog>; só fecha se o toque começou e terminou fora da folha.
      onDialogBackdropClick(dialog, () => this.cancel());
      void this.store.refreshPowerSchedule();
      // A folha pode ficar aberta no disparo; a leitura periódica traz o desfecho sem reenviar comando.
      const poll = window.setInterval(() => {
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
    this.chosen.set(new Date(Date.now() + minutes * 60_000));
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
      else this.chosen.set(null);
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
