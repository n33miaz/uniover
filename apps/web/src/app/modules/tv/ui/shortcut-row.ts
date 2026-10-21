import { Component, computed, inject, input, output } from '@angular/core';
import { TvAccess } from '../data/tv-access';
import { TvStore } from '../data/tv-store';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { AppIcon } from './app-icon';

/**
 * Fileira de cima do controle: os atalhos favoritos como azulejos quadrados, todos do mesmo tamanho, que abrem o app
 * (a faixa rola na horizontal quando passa da largura). Cada atalho é o ícone do app; o nome vai no nome acessível do
 * botão e na dica de quem passa o mouse. Sem nenhum atalho ativo, uma dica da altura de um azulejo diz onde fixá-los,
 * para o layout não saltar quando o primeiro chegar. Só apresenta: quem decide o que fazer com o toque é o controle,
 * e o painel Apps abre por um botão do cabeçalho.
 *
 * Quem não pode abrir apps (`launchable` falso) vê a mesma fileira, mas como figuras: sem botão, sem foco por azulejo,
 * sem realce ao passar o dedo ou o mouse, para nada ali prometer o que não faz. A faixa em si ganha o foco do teclado,
 * porque ela rola quando passa da largura e, sem nenhum botão dentro, o teclado não a alcançaria.
 */
@Component({
  selector: 'app-tv-shortcut-row',
  imports: [AppIcon],
  templateUrl: './shortcut-row.html',
  styleUrl: './shortcut-row.css',
})
export class ShortcutRow {
  /** Só os atalhos ativos, já na ordem da posição. */
  readonly shortcuts = input.required<readonly TvShortcut[]>();
  /** Sem agente ou sem rede os azulejos ficam apagados, mas focáveis (a faixa rolável precisa de algo que o teclado alcance). */
  readonly canSend = input(true);
  /** A pessoa pode abrir apps (`tv:launch`); sem isso os azulejos são só figuras. */
  readonly launchable = input(true);

  readonly open = output<TvShortcut>();

  private readonly store = inject(TvStore);
  /** Só quem edita os atalhos fixa apps: para os outros a dica não manda abrir o painel para fixar. */
  protected readonly canEdit = inject(TvAccess).editShortcuts;

  /** A lista ainda não chegou, nem a guardada: fileira vazia nesse instante não quer dizer "sem atalhos". */
  private readonly loading = computed(() => this.store.shortcuts() === null);
  protected readonly showHint = computed(() => this.shortcuts().length === 0 && !this.loading());

  protected label(shortcut: TvShortcut): string {
    return shortcutLabel(shortcut);
  }
}
