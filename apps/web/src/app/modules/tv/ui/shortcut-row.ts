import { Component, input, output } from '@angular/core';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { AppIcon } from './app-icon';
import { TvIcon } from './tv-icon';

/**
 * Fileira de cima do controle: o chip fixo "Apps" e, ao lado, os atalhos favoritos como chips que abrem o app (a faixa
 * deles rola na horizontal e o chip Apps fica parado). Cada atalho é o ícone do app; o nome vai no nome acessível do
 * botão e na dica de quem passa o mouse. Só apresenta: quem decide o que fazer com o toque é o controle.
 * O chip Apps devolve o próprio botão, porque o painel que ele abre devolve o foco a ele ao fechar.
 */
@Component({
  selector: 'app-tv-shortcut-row',
  imports: [AppIcon, TvIcon],
  templateUrl: './shortcut-row.html',
  styleUrl: './shortcut-row.css',
})
export class ShortcutRow {
  /** Só os atalhos ativos, já na ordem da posição. */
  readonly shortcuts = input.required<readonly TvShortcut[]>();
  /** Sem agente ou sem rede os chips ficam apagados, mas focáveis (a faixa rolável precisa de algo que o teclado alcance). */
  readonly canSend = input(true);

  readonly apps = output<HTMLElement>();
  readonly open = output<TvShortcut>();

  protected label(shortcut: TvShortcut): string {
    return shortcutLabel(shortcut);
  }

  protected askApps(event: Event): void {
    this.apps.emit(event.currentTarget as HTMLElement);
  }
}
