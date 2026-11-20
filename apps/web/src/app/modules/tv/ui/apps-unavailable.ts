import { Component, computed, inject, input, signal } from '@angular/core';
import { TvAccess } from '../data/tv-access';
import { AppsAvailability, appsAvailability } from '../data/tv-apps-availability';
import { TvStore } from '../data/tv-store';

/** O conserto de um toque que cada motivo oferece (nem todo motivo tem um). */
type Fix = 'ask-permission' | 'accepted' | 'search' | 'wake' | 'recheck';

/**
 * Diz por que a lista de apps da TV não está à vista e, quando existe, oferece o conserto de um toque: pedir a
 * permissão do ADB à TV (o mesmo pedido de "Atualizar lista", que faz o aviso aparecer nela), buscar a lista, ligar a TV
 * ou conferir de novo depois de reabrir o conector no computador (o instalador põe o ADB sozinho). Nunca deixa uma
 * lista vazia sem explicação. Cada botão só aparece para quem pode usá-lo. `compact` é a versão da fileira de atalhos.
 */
@Component({
  selector: 'app-tv-apps-unavailable',
  templateUrl: './apps-unavailable.html',
  styleUrl: './apps-unavailable.css',
  host: { '[class.compact]': 'compact()' },
})
export class AppsUnavailable {
  private readonly store = inject(TvStore);
  private readonly access = inject(TvAccess);

  readonly compact = input(false);

  protected readonly busy = signal(false);

  readonly reason = computed<AppsAvailability>(() =>
    appsAvailability({
      shortcuts: this.store.shortcuts(),
      state: this.store.state(),
      tv: this.store.selectedTv(),
    }),
  );

  protected readonly message = computed<string | null>(() => {
    switch (this.reason()) {
      case 'pc-off':
        return (
          this.store.disabledReason() ??
          $localize`:@@tv.apps-why.pc-off:O computador que controla a TV está desligado ou sem internet.`
        );
      case 'no-adb':
        return $localize`:@@tv.apps-why.no-adb:O computador da TV ainda não tem o ADB, que lista os apps. Abra o conector UniOver de novo no computador: ele instala o ADB sozinho.`;
      case 'adb-permission':
        return $localize`:@@tv.apps-why.permission:A TV ainda não liberou o UniOver para ver os apps.`;
      case 'adb-pending':
        return $localize`:@@tv.apps-why.pending:Aceite o aviso na tela da TV (marque "Sempre permitir").`;
      case 'tv-off':
        return $localize`:@@tv.apps-why.tv-off:A TV não está respondendo. Ligue a TV para ver os apps.`;
      case 'empty':
        return $localize`:@@tv.apps-why.empty:A TV ainda não informou os apps instalados.`;
      default:
        return null;
    }
  });

  protected readonly fix = computed<Fix | null>(() => {
    const launch = this.access.launch();
    switch (this.reason()) {
      case 'no-adb':
        return 'recheck';
      case 'adb-permission':
        return launch ? 'ask-permission' : null;
      case 'adb-pending':
        return launch ? 'accepted' : null;
      case 'tv-off':
        return this.access.control() ? 'wake' : null;
      case 'empty':
        return launch ? 'search' : null;
      default:
        return null;
    }
  });

  /** Quem não pode consertar sabe a quem pedir (só onde o conserto é na TV). */
  protected readonly askOwner = computed(
    () => this.fix() === null && (this.reason() === 'adb-permission' || this.reason() === 'empty'),
  );

  /** Conferir de novo não fala com a TV; os outros consertos precisam do agente. */
  protected readonly blocked = computed(
    () => this.busy() || (this.fix() !== 'recheck' && !this.store.canSend()),
  );

  protected async run(): Promise<void> {
    const fix = this.fix();
    if (!fix || this.blocked()) return;
    this.busy.set(true);
    try {
      if (fix === 'wake') await this.store.wake();
      else if (fix === 'recheck') await this.store.refresh();
      else await this.store.refreshShortcuts();
    } finally {
      this.busy.set(false);
    }
  }
}
