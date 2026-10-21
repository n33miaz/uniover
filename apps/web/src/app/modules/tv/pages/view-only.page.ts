import { Component, computed, inject } from '@angular/core';
import { TvAccess } from '../data/tv-access';
import { TvStore } from '../data/tv-store';
import { TvShortcut } from '../data/tv-types';
import { vibrate } from '../input/key-button';
import { ShortcutRow } from '../ui/shortcut-row';
import { TvIcon } from '../ui/tv-icon';

/**
 * O lugar do controle para quem pode ver a TV mas não controlá-la (tem `module:tv`, não tem `tv:control`): a mesma
 * fileira de atalhos de cima (que abre apps só para quem tem `tv:launch`) e uma única frase no lugar do anel, das
 * pílulas e dos botões, que nem existem aqui. Não é um erro nem um bloqueio: é o que esta conta pode ver. A página da
 * TV escolhe entre este componente e o controle conforme a permissão, e a troca acontece sozinha quando a sessão traz
 * outra lista.
 */
@Component({
  selector: 'app-tv-view-only',
  imports: [ShortcutRow, TvIcon],
  templateUrl: './view-only.page.html',
  styleUrl: './view-only.page.css',
})
export class ViewOnlyPage {
  protected readonly store = inject(TvStore);
  protected readonly canLaunch = inject(TvAccess).launch;

  /** Só os atalhos ativos, na ordem da posição (a mesma fileira do controle). */
  protected readonly shortcuts = computed(() =>
    (this.store.shortcuts() ?? []).filter((shortcut) => shortcut.enabled),
  );

  protected openShortcut(shortcut: TvShortcut): void {
    if (!this.store.canSend() || !this.canLaunch()) return;
    vibrate();
    void this.store.launch(shortcut);
  }
}
