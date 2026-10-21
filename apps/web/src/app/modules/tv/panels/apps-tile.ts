import { Component, computed, input, output } from '@angular/core';
import { ControlRank } from '../data/tv-order';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { AppIcon } from '../ui/app-icon';
import { TvIcon } from '../ui/tv-icon';

/**
 * Alfinete (24x24, contorno; cheio quando `filled`) para "no controle". O conjunto de ícones do controle não tem um, e
 * ele só serve ao painel Apps. Decorativo: quem o usa dá o nome ao botão.
 */
@Component({
  selector: 'app-tv-pin',
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path [attr.d]="path" [attr.fill]="filled() ? 'currentColor' : 'none'" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      width: 1.5em;
      height: 1.5em;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class PinGlyph {
  readonly filled = input(false);
  /** Por vínculo, como no `TvIcon`: o lint de i18n trata o atributo fixo `d` como texto de tela. */
  protected readonly path = 'M9 4h6 M10 4v5l-3 4h10l-3-4V4 M12 13v7';
}

/** Pedido de mover um atalho um passo na fileira do controle: -1 para a esquerda (mais perto do começo), 1 para a direita. */
export interface TileMove {
  readonly shortcut: TvShortcut;
  readonly delta: -1 | 1;
}

/**
 * Azulejo de um app no painel Apps: o ícone quadrado e grande com o nome embaixo (até duas linhas). Normalmente é um
 * botão que abre o app; no modo de edição não abre nada (para um dedo errado não ligar app na TV) e mostra o pacote e
 * os botões de fixar no controle e de renomear. Só apresenta: quem fala com a TV e com a API é o painel. Estar ou não
 * no controle não muda o azulejo nem o impede de abrir (a API abre todo app instalado); o painel é quem só mostra os
 * instalados. Quando o painel diz o lugar do app na fileira (`rank`), o azulejo de edição ganha dois botões que o movem
 * um passo para a esquerda ou para a direita; nas pontas o botão fica `aria-disabled` (e não `disabled`), para o foco
 * de quem acabou de empurrar o app até lá não se perder.
 */
@Component({
  selector: 'app-tv-apps-tile',
  imports: [AppIcon, PinGlyph, TvIcon],
  templateUrl: './apps-tile.html',
  styleUrl: './apps-tile.css',
})
export class AppsTile {
  readonly shortcut = input.required<TvShortcut>();
  /** Modo de edição (só do dono): em vez de abrir, o azulejo mostra o pacote e os botões de fixar e renomear. */
  readonly managing = input(false);
  /** Lista única (busca ou edição): quem está no controle leva uma marca, já que nenhuma seção diz isso. */
  readonly marked = input(false);
  readonly canSend = input(true);
  /** Um pedido de fixar ou tirar está em curso: o botão fica apagado, mas segue focável. */
  readonly busy = input(false);
  /** Lugar do app na fileira do controle; só vem quando dá para mudar a ordem (edição, sem busca, app no controle). */
  readonly rank = input<ControlRank | null>(null);

  readonly launch = output<TvShortcut>();
  /** Pede para fixar o app no controle ou, se ele já está lá, para tirá-lo. */
  readonly pin = output<TvShortcut>();
  readonly rename = output<TvShortcut>();
  readonly move = output<TileMove>();

  protected readonly name = computed(() => shortcutLabel(this.shortcut()));
  /** A marca "No controle" chega ao leitor de tela como descrição do botão, sem mudar o nome dele. */
  protected readonly describedBy = computed(() => `in-control-${this.shortcut().id}`);

  protected readonly renameLabel = computed(() => {
    const name = this.name();
    return $localize`:@@tv.apps.rename-label:Renomear ${name}:name:`;
  });

  protected readonly moveLeftLabel = computed(() => {
    const name = this.name();
    return $localize`:@@tv.apps.move-left-label:Mover ${name}:name: para a esquerda`;
  });

  protected readonly moveRightLabel = computed(() => {
    const name = this.name();
    return $localize`:@@tv.apps.move-right-label:Mover ${name}:name: para a direita`;
  });

  protected readonly atStart = computed(() => this.rank()?.index === 0);
  protected readonly atEnd = computed(() => {
    const rank = this.rank();
    return !!rank && rank.index === rank.count - 1;
  });

  protected onMove(delta: -1 | 1): void {
    // Na ponta o botão só está apagado (segue focável): tocar nele não faz nada.
    if (delta < 0 ? this.atStart() : this.atEnd()) return;
    this.move.emit({ shortcut: this.shortcut(), delta });
  }

  protected readonly toggleLabel = computed(() => {
    const name = this.name();
    return this.shortcut().enabled
      ? $localize`:@@tv.apps.unpin-label:Tirar ${name}:name: do controle`
      : $localize`:@@tv.apps.pin-label:Fixar ${name}:name: no controle`;
  });
}
