import type { PcKey, PcModifier } from '../data/pc-types';
import { textSteps, type TextDiff } from './live-typing';

/**
 * Um pedaço do eco: um caractere digitado (`text`) ou uma tecla especial mostrada como símbolo curto (`key`). `erasable` diz se
 * o Backspace do PC o apaga de verdade: um caractere, um Enter ou um Tab sim; depois de uma seta ou de um atalho o cursor do PC
 * mudou de lugar e não dá para saber o que o Backspace levou.
 */
export interface EchoToken {
  readonly kind: 'text' | 'key';
  readonly value: string;
  readonly erasable: boolean;
}

/** Um trecho para a tela: texto corrido ou uma tecla. */
export interface EchoSegment {
  readonly kind: 'text' | 'key';
  readonly value: string;
}

/** O eco nunca guarda mais que isto (o que sai da frente some); a tela mostra só o fim. */
export const ECHO_MAX_TOKENS = 200;
/** Quanto do fim a tela mostra (a linha é uma só). */
export const ECHO_VISIBLE_TOKENS = 60;

/**
 * Como cada tecla aparece no eco. As que viram um caractere no campo do PC (espaço, dígitos, pontuação, letras) aparecem como o
 * caractere e o Backspace as apaga; as outras como um símbolo curto. Um `Record` fechado: uma tecla nova no contrato obriga a
 * dizer como ela aparece.
 */
/** O apagar que o eco não sabe desfazer (depois de uma seta ou de um atalho). */
const ERASE_SYMBOL = '⌫';

/** O envio falhou: o texto antes dele pode não ter chegado. */
export const FAILED_SYMBOL = '⚠';

const KEY_ECHO: Readonly<Record<PcKey, { readonly text: string } | { readonly symbol: string }>> = {
  ENTER: { symbol: '⏎' },
  BACKSPACE: { symbol: ERASE_SYMBOL },
  DELETE: { symbol: '⌦' },
  TAB: { symbol: '⇥' },
  ESCAPE: { symbol: 'Esc' },
  SPACE: { text: ' ' },
  UP: { symbol: '↑' },
  DOWN: { symbol: '↓' },
  LEFT: { symbol: '←' },
  RIGHT: { symbol: '→' },
  HOME: { symbol: 'Home' },
  END: { symbol: 'End' },
  PAGE_UP: { symbol: 'PgUp' },
  PAGE_DOWN: { symbol: 'PgDn' },
  F1: { symbol: 'F1' },
  F2: { symbol: 'F2' },
  F3: { symbol: 'F3' },
  F4: { symbol: 'F4' },
  F5: { symbol: 'F5' },
  F6: { symbol: 'F6' },
  F7: { symbol: 'F7' },
  F8: { symbol: 'F8' },
  F9: { symbol: 'F9' },
  F10: { symbol: 'F10' },
  F11: { symbol: 'F11' },
  F12: { symbol: 'F12' },
  A: { text: 'a' },
  B: { text: 'b' },
  C: { text: 'c' },
  D: { text: 'd' },
  E: { text: 'e' },
  F: { text: 'f' },
  G: { text: 'g' },
  H: { text: 'h' },
  I: { text: 'i' },
  J: { text: 'j' },
  K: { text: 'k' },
  L: { text: 'l' },
  M: { text: 'm' },
  N: { text: 'n' },
  O: { text: 'o' },
  P: { text: 'p' },
  Q: { text: 'q' },
  R: { text: 'r' },
  S: { text: 's' },
  T: { text: 't' },
  U: { text: 'u' },
  V: { text: 'v' },
  W: { text: 'w' },
  X: { text: 'x' },
  Y: { text: 'y' },
  Z: { text: 'z' },
  D0: { text: '0' },
  D1: { text: '1' },
  D2: { text: '2' },
  D3: { text: '3' },
  D4: { text: '4' },
  D5: { text: '5' },
  D6: { text: '6' },
  D7: { text: '7' },
  D8: { text: '8' },
  D9: { text: '9' },
  MINUS: { text: '-' },
  EQUALS: { text: '=' },
  COMMA: { text: ',' },
  PERIOD: { text: '.' },
  INSERT: { symbol: 'Ins' },
  PRINT_SCREEN: { symbol: 'PrtSc' },
  APPS: { symbol: 'Menu' },
  WIN: { symbol: 'Win' },
  CAPS_LOCK: { symbol: 'Caps' },
  CTRL: { symbol: 'Ctrl' },
  ALT: { symbol: 'Alt' },
  SHIFT: { symbol: 'Shift' },
};

const MODIFIER_ECHO: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

/** O nome curto de uma tecla com modificadores ("Ctrl+C"). */
export function keyLabel(key: PcKey, modifiers: readonly PcModifier[] = []): string {
  const echo = KEY_ECHO[key];
  const base =
    'text' in echo ? (echo.text === ' ' ? 'Espaço' : echo.text.toUpperCase()) : echo.symbol;
  return [...modifiers.map((modifier) => MODIFIER_ECHO[modifier]), base].join('+');
}

/**
 * O eco do que se digitou no PC nesta sessão de digitação, só para mostrar na tela do celular. Vive só na memória: nunca vai
 * para armazenamento, registro ou telemetria (o campo do PC pode ser uma senha) e se esvazia quando o teclado fecha. Recebe o
 * mesmo que vai ao PC (a diferença do campo e as teclas), sem mudar nada do envio.
 */
export class TypedEcho {
  private tokens: EchoToken[] = [];

  /** Os pedaços guardados (para testes). */
  get all(): readonly EchoToken[] {
    return this.tokens;
  }

  get empty(): boolean {
    return this.tokens.length === 0;
  }

  /** Uma mudança do campo: apaga `erase` do fim e acrescenta o texto, com Enter e Tab como o PC os recebe. */
  edit(diff: TextDiff): void {
    this.erase(diff.erase);
    for (const step of textSteps(diff.insert)) {
      if (step.kind === 'key')
        this.push({ kind: 'key', value: keyLabel(step.key), erasable: true });
      else for (const char of step.text) this.push({ kind: 'text', value: char, erasable: true });
    }
  }

  /** Uma tecla enviada (da barra, do painel ou do teclado do celular), com os modificadores que levou. */
  key(key: PcKey, modifiers: readonly PcModifier[] = []): void {
    if (modifiers.length === 0) {
      if (key === 'BACKSPACE') return this.erase(1);
      const echo = KEY_ECHO[key];
      if ('text' in echo) return this.push({ kind: 'text', value: echo.text, erasable: true });
      // Enter e Tab entram no texto do campo do PC: o Backspace os tira; o resto só mexe no cursor ou na janela.
      return this.push({
        kind: 'key',
        value: echo.symbol,
        erasable: key === 'ENTER' || key === 'TAB',
      });
    }
    // Shift com uma letra é a maiúscula: aparece como o caractere.
    const echo = KEY_ECHO[key];
    if (
      modifiers.length === 1 &&
      modifiers[0] === 'SHIFT' &&
      'text' in echo &&
      /[a-z]/.test(echo.text)
    ) {
      return this.push({ kind: 'text', value: echo.text.toUpperCase(), erasable: true });
    }
    this.push({ kind: 'key', value: keyLabel(key, modifiers), erasable: false });
  }

  /** `count` apertos da mesma tecla (segurar apagar ou uma seta). */
  repeat(key: PcKey, count: number, modifiers: readonly PcModifier[] = []): void {
    for (let index = 0; index < count; index++) this.key(key, modifiers);
  }

  /**
   * Apaga do fim. Depois de uma seta ou de um atalho o eco não sabe o que o PC apagou: entra o símbolo do apagar, em vez de
   * fingir que sabe.
   */
  erase(count: number): void {
    for (let index = 0; index < count; index++) {
      const last = this.tokens.at(-1);
      if (!last) return;
      if (last.erasable) this.tokens.pop();
      else this.push({ kind: 'key', value: ERASE_SYMBOL, erasable: false });
    }
  }

  /**
   * Um envio falhou: o que o eco mostra antes disto pode não ter chegado ao PC. Entra um aviso que o Backspace não desfaz (o
   * eco não sabe mais o que o PC tem).
   */
  failed(): void {
    this.push({ kind: 'key', value: FAILED_SYMBOL, erasable: false });
  }

  clear(): void {
    this.tokens = [];
  }

  /** O fim do eco em trechos para a tela: os caracteres seguidos se juntam. */
  view(limit = ECHO_VISIBLE_TOKENS): readonly EchoSegment[] {
    const shown = this.tokens.slice(-limit);
    const segments: EchoSegment[] = [];
    for (const token of shown) {
      const last = segments.at(-1);
      if (token.kind === 'text' && last?.kind === 'text') {
        segments[segments.length - 1] = { kind: 'text', value: last.value + token.value };
      } else segments.push({ kind: token.kind, value: token.value });
    }
    return segments;
  }

  private push(token: EchoToken): void {
    this.tokens.push(token);
    if (this.tokens.length > ECHO_MAX_TOKENS)
      this.tokens.splice(0, this.tokens.length - ECHO_MAX_TOKENS);
  }
}
