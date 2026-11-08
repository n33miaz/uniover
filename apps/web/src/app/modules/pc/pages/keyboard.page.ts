import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { PcStore } from '../data/pc-store';
import { tick } from '../input/haptics';
import { clampText } from '../input/text-limit';
import { PC_MODIFIERS, type PcKey, type PcLetter, type PcModifier } from '../data/pc-types';

interface KeyButton {
  readonly key: PcKey;
  readonly modifiers?: readonly PcModifier[];
  readonly label: string;
  /** O que o leitor de tela diz (o rótulo é curto ou é um símbolo). */
  readonly aria?: string;
}

/** O limite do contrato para o texto de uma vez, em pontos de código (um emoji vale um). */
const MAX_TEXT = 200;

/** O pior caso do limite em unidades de 16 bits do HTML (cada ponto de código vale até duas); o corte certo é o do `clampText`. */
const MAX_UNITS = MAX_TEXT * 2;

/** Os nomes das teclas modificadoras não se traduzem: são as que estão no teclado do PC. */
const MODIFIER_LABEL: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

/**
 * Teclado do PC: um campo para digitar texto (vai inteiro, com acentos, para onde o cursor do PC estiver) e as teclas e os
 * atalhos que o teclado do celular não tem. Cada toque é um comando; o texto digitado nunca fica guardado na tela depois
 * de enviado (pode ser uma senha). Ctrl, Shift, Alt e Win são teclas "armadas": ficam marcadas e valem só para a próxima
 * tecla, que sai como um atalho (com o campo, uma letra sozinha vira a tecla, por exemplo Ctrl armado e "c" é Ctrl+C). Qualquer envio, de tecla ou de texto, solta as armadas.
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
        [maxLength]="maxUnits"
        [value]="text()"
        [disabled]="!store.canSend()"
        placeholder="Digite aqui"
        i18n-placeholder="@@pc.keyboard.placeholder"
        (input)="onInput($event)"
      />
      <button
        type="submit"
        class="ui-btn primary"
        [disabled]="!store.canSend() || text().length === 0"
        i18n="@@pc.keyboard.send"
      >
        Digitar
      </button>
    </form>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }

    <div
      class="mods"
      role="group"
      aria-label="Teclas armadas"
      i18n-aria-label="@@pc.keyboard.modifiers"
    >
      @for (mod of modifiers; track mod) {
        <button
          type="button"
          class="key mod"
          [class.armed]="isArmed(mod)"
          [attr.aria-pressed]="isArmed(mod)"
          [disabled]="!store.canSend()"
          (click)="toggle(mod)"
        >
          {{ label(mod) }}
        </button>
      }
    </div>

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

    <div
      class="keys fkeys"
      role="group"
      aria-label="F1 a F12"
      i18n-aria-label="@@pc.keyboard.fkeys"
    >
      @for (item of functionKeys; track item.key) {
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
  protected readonly maxUnits = MAX_UNITS;
  protected readonly modifiers = PC_MODIFIERS;
  /** As teclas armadas: valem para a próxima tecla e então se soltam sozinhas. */
  protected readonly armed = signal<ReadonlySet<PcModifier>>(new Set());
  protected readonly text = signal('');
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

  protected readonly functionKeys: readonly KeyButton[] = (
    ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'] as const
  ).map((key) => ({ key, label: key }));

  protected label(modifier: PcModifier): string {
    return MODIFIER_LABEL[modifier];
  }

  protected isArmed(modifier: PcModifier): boolean {
    return this.armed().has(modifier);
  }

  protected toggle(modifier: PcModifier): void {
    tick();
    const next = new Set(this.armed());
    if (!next.delete(modifier)) next.add(modifier);
    this.armed.set(next);
  }

  protected onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    // O limite é em pontos de código: o do HTML contaria um emoji como dois e poderia cortá-lo ao meio.
    const clamped = clampText(input.value, MAX_TEXT);
    if (clamped !== input.value) {
      const caret = Math.min(input.selectionStart ?? clamped.length, clamped.length);
      input.value = clamped;
      input.setSelectionRange?.(caret, caret);
    }
    this.text.set(clamped);
    this.error.set(null);
  }

  /**
   * O campo esvazia na hora e o PC recebe em segundo plano: o próximo texto não espera a resposta do anterior (uma ida e
   * volta até o PC). Se não passou, o texto volta ao campo (se a pessoa ainda não digitou outra coisa) junto com o motivo.
   */
  protected send(): void {
    const value = clampText(this.text(), MAX_TEXT);
    if (!value || !this.store.canSend()) return;
    tick();
    this.text.set('');
    this.error.set(null);
    void this.sendValue(value).then((failure) => {
      if (!failure) return;
      this.error.set(failure.message);
      if (this.text() === '') this.text.set(value);
    });
  }

  protected press(item: KeyButton): void {
    // Sem como enviar, nada é gasto: as teclas armadas esperam o próximo envio de verdade.
    if (!this.store.canSend()) return;
    tick();
    void this.store.sendKey(item.key, this.takeModifiers(item.modifiers));
  }

  /**
   * Qualquer envio gasta as teclas armadas. Com elas, uma letra sozinha no campo é o atalho; qualquer outro texto vai
   * inteiro, como texto, e as armadas se soltam do mesmo jeito (modificador não vale para texto).
   */
  private sendValue(value: string) {
    const armed = this.takeModifiers();
    if (armed.length > 0 && /^[a-z]$/i.test(value)) {
      return this.store.sendKey(value.toUpperCase() as PcLetter, armed);
    }
    return this.store.sendText(value);
  }

  /** Junta o que está armado ao do atalho e solta tudo: as teclas armadas valem uma vez só. */
  private takeModifiers(base: readonly PcModifier[] = []): readonly PcModifier[] {
    const armed = this.armed();
    if (armed.size === 0) return base;
    this.armed.set(new Set());
    return PC_MODIFIERS.filter((mod) => armed.has(mod) || base.includes(mod));
  }
}
