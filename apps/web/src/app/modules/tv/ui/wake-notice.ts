import { Component, computed, inject, signal } from '@angular/core';
import { TvAdbPermission } from '../data/tv-adb-permission';
import { TvStore } from '../data/tv-store';
import type { TvWakeHint } from '../data/tv-types';

/**
 * Aviso curto de ligar a TV pelo celular (só TV TCL; o agente é quem sabe e conta em `wakeHints`). Dois casos:
 * - `screenless_off`: o "Screenless service" está desligado na TV, e o aviso diz o caminho no menu para ligá-lo;
 * - `replug`: ligar pela rede ficou sem resposta, numa TV que liga sozinha quando a energia volta.
 *
 * Só lê o estado: nada daqui grava na TV nem abre aviso nela. Não bloqueia o controle e cede a vez ao recado da
 * permissão do ADB (os dois ocupam o mesmo lugar). "Ok" cala o aviso até o app abrir de novo.
 */
@Component({
  selector: 'app-tv-wake-notice',
  templateUrl: './wake-notice.html',
  styleUrl: './wake-notice.css',
})
export class WakeNotice {
  private readonly store = inject(TvStore);
  private readonly permission = inject(TvAdbPermission);
  private readonly dismissed = signal<ReadonlySet<TvWakeHint>>(new Set());

  /** O aviso da vez: tirar da tomada vem antes (a TV não ligou agora), o ajuste do menu depois. */
  protected readonly hint = computed<TvWakeHint | null>(() => {
    const state = this.store.state();
    if (this.store.link() !== 'ok' || state?.agentOnline !== true) return null;
    if (
      this.permission.sheetOpen() ||
      this.permission.waiting() ||
      this.permission.done() ||
      this.permission.cleared()
    ) {
      return null;
    }
    const hints = state.wakeHints ?? [];
    const hidden = this.dismissed();
    return (
      (['replug', 'screenless_off'] as const).find(
        (item) => hints.includes(item) && !hidden.has(item),
      ) ?? null
    );
  });

  protected dismiss(hint: TvWakeHint): void {
    this.dismissed.update((current) => new Set([...current, hint]));
  }
}
