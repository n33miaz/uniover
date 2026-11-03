import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { PcStore } from '../data/pc-store';
import { tick } from '../input/haptics';
import type { PcKey, PcModifier } from '../data/pc-types';

interface KeyButton {
  readonly key: PcKey;
  readonly modifiers?: readonly PcModifier[];
  readonly label: string;
  /** O que o leitor de tela diz (o rótulo é curto ou é um símbolo). */
  readonly aria?: string;
}

/** O limite do contrato para o texto de uma vez. */
const MAX_TEXT = 200;

/**
 * Teclado do PC: um campo para digitar texto (vai inteiro, com acentos, para onde o cursor do PC estiver) e as teclas e os
 * atalhos que o teclado do celular não tem. Cada toque é um comando; o texto digitado nunca fica guardado na tela depois
 * de enviado (pode ser uma senha).
 */
@Component({
  selector: 'app-pc-keyboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="typing" (submit)="$event.preventDefault(); send()">
      <label class="sr-only" for="pc-text" i18n="@@pc.keyboard.field"
        >Texto para digitar no PC</label
      >
      <input
        id="pc-text"
        type="text"
        class="field"
        autocomplete="off"
        [attr.autocapitalize]="'off'"
        [attr.autocorrect]="'off'"
        spellcheck="false"
        [attr.enterkeyhint]="'send'"
        [maxLength]="max"
        [value]="text()"
        [disabled]="!store.canSend()"
        placeholder="Digite aqui"
        i18n-placeholder="@@pc.keyboard.placeholder"
        (input)="onInput($event)"
      />
      <button
        type="submit"
        class="ui-btn primary"
        [disabled]="!store.canSend() || text().length === 0 || sending()"
        i18n="@@pc.keyboard.send"
      >
        Digitar
      </button>
    </form>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }

    <div class="keys main" role="group" aria-labelledby="keys-title">
      <h2 id="keys-title" class="sr-only" i18n="@@pc.keyboard.keys">Teclas</h2>
      @for (item of mainKeys; track item.label) {
        <button
          type="button"
          class="key"
          [attr.aria-label]="item.aria ?? null"
          [disabled]="!store.canSend()"
          (click)="press(item)"
        >
          {{ item.label }}
        </button>
      }
    </div>

    <div class="arrows" role="group" aria-labelledby="arrows-title">
      <h2 id="arrows-title" class="sr-only" i18n="@@pc.keyboard.arrows">Setas</h2>
      @for (item of arrowKeys; track item.key) {
        <button
          type="button"
          class="key"
          [attr.data-key]="item.key"
          [attr.aria-label]="item.aria ?? null"
          [disabled]="!store.canSend()"
          (click)="press(item)"
        >
          {{ item.label }}
        </button>
      }
    </div>

    <h2 class="section" i18n="@@pc.keyboard.shortcuts">Atalhos</h2>
    <div
      class="keys"
      role="group"
      aria-label="Atalhos"
      i18n-aria-label="@@pc.keyboard.shortcuts-label"
    >
      @for (item of shortcuts(); track item.label) {
        <button type="button" class="key" [disabled]="!store.canSend()" (click)="press(item)">
          {{ item.label }}
        </button>
      }
    </div>
  `,
  styleUrl: './keyboard.page.css',
})
export class KeyboardPage {
  protected readonly store = inject(PcStore);
  protected readonly max = MAX_TEXT;
  protected readonly text = signal('');
  protected readonly sending = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly mainKeys: readonly KeyButton[] = [
    { key: 'ESCAPE', label: 'Esc', aria: $localize`:@@pc.key.escape:Esc (Escape)` },
    { key: 'TAB', label: 'Tab', aria: $localize`:@@pc.key.tab:Tab` },
    { key: 'BACKSPACE', label: '⌫', aria: $localize`:@@pc.key.backspace:Apagar` },
    { key: 'ENTER', label: '↵', aria: $localize`:@@pc.key.enter:Enter` },
    { key: 'DELETE', label: 'Del', aria: $localize`:@@pc.key.delete:Del (Delete)` },
    { key: 'HOME', label: 'Home', aria: $localize`:@@pc.key.home:Home (início da linha)` },
    { key: 'END', label: 'End', aria: $localize`:@@pc.key.end:End (fim da linha)` },
    { key: 'PAGE_UP', label: 'PgUp', aria: $localize`:@@pc.key.page-up:PgUp (página para cima)` },
    {
      key: 'PAGE_DOWN',
      label: 'PgDn',
      aria: $localize`:@@pc.key.page-down:PgDn (página para baixo)`,
    },
    { key: 'SPACE', label: '␣', aria: $localize`:@@pc.key.space:Espaço` },
  ];

  protected readonly arrowKeys: readonly KeyButton[] = [
    { key: 'UP', label: '↑', aria: $localize`:@@pc.key.up:Seta para cima` },
    { key: 'LEFT', label: '←', aria: $localize`:@@pc.key.left:Seta para a esquerda` },
    { key: 'DOWN', label: '↓', aria: $localize`:@@pc.key.down:Seta para baixo` },
    { key: 'RIGHT', label: '→', aria: $localize`:@@pc.key.right:Seta para a direita` },
  ];

  /** Os atalhos que mais se usa sem teclado físico. Os rótulos descrevem o que fazem, não as teclas. */
  protected readonly shortcuts = signal<readonly KeyButton[]>([
    { key: 'C', modifiers: ['CTRL'], label: $localize`:@@pc.shortcut.copy:Copiar` },
    { key: 'V', modifiers: ['CTRL'], label: $localize`:@@pc.shortcut.paste:Colar` },
    { key: 'X', modifiers: ['CTRL'], label: $localize`:@@pc.shortcut.cut:Recortar` },
    { key: 'Z', modifiers: ['CTRL'], label: $localize`:@@pc.shortcut.undo:Desfazer` },
    { key: 'A', modifiers: ['CTRL'], label: $localize`:@@pc.shortcut.select-all:Selecionar Tudo` },
    { key: 'TAB', modifiers: ['ALT'], label: $localize`:@@pc.shortcut.switch:Trocar Janela` },
    { key: 'D', modifiers: ['WIN'], label: $localize`:@@pc.shortcut.desktop:Área de Trabalho` },
    { key: 'F4', modifiers: ['ALT'], label: $localize`:@@pc.shortcut.close:Fechar Janela` },
  ]);

  protected onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected async send(): Promise<void> {
    const value = this.text();
    if (!value || this.sending() || !this.store.canSend()) return;
    this.sending.set(true);
    tick();
    const failure = await this.store.sendText(value);
    this.sending.set(false);
    if (failure) {
      this.error.set(failure.message);
      return;
    }
    // Enviado: o campo esvazia, e nada do que foi digitado fica na tela.
    this.text.set('');
  }

  protected press(item: KeyButton): void {
    tick();
    void this.store.sendKey(item.key, item.modifiers ?? []);
  }
}
