import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { PcInput } from '../data/pc-input';
import { keysText, shortcutById, type PcShortcut } from '../data/pc-shortcuts';
import { PcStore } from '../data/pc-store';
import { shortcutLabel } from './shortcut-labels';

/**
 * Uma fileira de atalhos do catálogo (os do Vídeo e os da Apresentação), em grade: o nome do que fazem e a tecla pequena
 * embaixo. O catálogo (`pc-shortcuts`) é a única tabela de teclas: aqui só entram ids dele. Cada toque manda a tecla com os
 * modificadores do próprio atalho e NADA mais: as teclas armadas na tela do mouse não valem aqui (quem toca "Voltar 5 s" não
 * quer um Ctrl+Seta), e com o Alt do "Trocar janela" segurado os botões ficam desligados (sairia Alt+tecla). O que precisa de `pc.key.v2` some num PC que não a declarou, como na lista de atalhos.
 */
@Component({
  selector: 'app-pc-shortcut-cells',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.--cols]': 'columns()' },
  template: `
    @for (item of items(); track item.id) {
      <button
        type="button"
        class="cell"
        [attr.data-shortcut]="item.id"
        [disabled]="!store.canSend() || input.held()"
        (click)="send(item)"
      >
        <span class="name">{{ label(item) }}</span>
        @if (keys(item); as text) {
          <span class="keys">{{ text }}</span>
        }
      </button>
    }
  `,
  styleUrl: './shortcut-cells.css',
})
export class PcShortcutCells {
  protected readonly store = inject(PcStore);
  protected readonly input = inject(PcInput);

  /** Os ids do catálogo, na ordem em que aparecem. */
  readonly ids = input.required<readonly string[]>();
  /** Quantas colunas (o texto cabe em duas linhas). */
  readonly columns = input(3);
  /** Um toque saiu para o PC. */
  readonly used = output<string>();

  protected readonly items = computed<readonly PcShortcut[]>(() =>
    this.ids()
      .map((id) => shortcutById(id))
      .filter(
        (shortcut): shortcut is PcShortcut =>
          shortcut !== undefined &&
          shortcut.action.kind === 'keys' &&
          (!shortcut.needs || this.store.supportsKeyV2()),
      ),
  );

  protected label(item: PcShortcut): string {
    return shortcutLabel(item.id);
  }

  protected keys(item: PcShortcut): string {
    return keysText(item);
  }

  protected send(item: PcShortcut): void {
    if (item.action.kind !== 'keys') return;
    if (this.input.plain(item.action.key, item.action.modifiers)) this.used.emit(item.id);
  }
}
