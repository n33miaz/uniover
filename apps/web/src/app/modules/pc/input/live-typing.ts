import type { PcFailure } from '../data/pc-failure';
import type { PcKey, PcModifier } from '../data/pc-types';
import { clampText } from './text-limit';

/** O limite do contrato para o texto de um pedido, em pontos de código (um emoji vale um). */
export const MAX_TEXT = 200;

/** A diferença entre dois textos: apagar `erase` pontos de código do fim e digitar `insert`. */
export interface TextDiff {
  readonly erase: number;
  readonly insert: string;
}

/**
 * A diferença entre o texto que o PC já tem e o do campo, por prefixo comum e em pontos de código (um emoji é um, nunca
 * dois pedaços de 16 bits): apaga o que sobrou do texto antigo e digita o resto do novo. É a mesma conta do campo ao vivo
 * do controle da TV, e vale também para uma troca de palavra do teclado do celular (apaga a palavra, digita a nova).
 */
export function diffText(previous: string, next: string): TextDiff {
  const before = Array.from(previous);
  const after = Array.from(next);
  const limit = Math.min(before.length, after.length);
  let common = 0;
  while (common < limit && before[common] === after[common]) common++;
  return { erase: before.length - common, insert: after.slice(common).join('') };
}

/**
 * O caractere de preenchimento do campo: invisível, nunca digitado por ninguém e nunca enviado ao PC. Existe para apagar com
 * o campo "vazio" ainda gerar um evento (ver `SENTINEL` em `live-keyboard`).
 */
export const PADDING_CHAR = '​';

/** O que o campo escondido mostra, separado em texto digitado e quantidade de preenchimento. */
export interface FieldState {
  readonly typed: string;
  readonly padding: number;
}

export function fieldState(value: string): FieldState {
  let padding = 0;
  let typed = '';
  for (const char of value) {
    if (char === PADDING_CHAR) padding++;
    else typed += char;
  }
  return { typed, padding };
}

/**
 * O que o campo mudou desde `before`. O preenchimento nunca vira texto: a diferença é do texto digitado (sem ele). Se o
 * texto digitado não mudou e sobrou menos preenchimento, a pessoa apagou com o campo vazio: cada caractere de preenchimento
 * que sumiu é um Backspace. Se o texto mudou junto (selecionar tudo e digitar por cima, uma troca de palavra), só a mudança
 * do texto conta: o preenchimento que sumiu não era do PC.
 */
export function fieldDiff(
  before: FieldState,
  value: string,
): { diff: TextDiff; after: FieldState } {
  const after = fieldState(value);
  const diff = diffText(before.typed, after.typed);
  if (diff.erase === 0 && diff.insert === '' && after.padding < before.padding) {
    return { diff: { erase: before.padding - after.padding, insert: '' }, after };
  }
  return { diff, after };
}

/** Junta duas diferenças seguidas numa só: o que a segunda apaga do que a primeira ainda ia digitar nem chega a sair. */
export function mergeDiff(first: TextDiff, second: TextDiff): TextDiff {
  const typed = Array.from(first.insert);
  let erase = first.erase;
  if (second.erase <= typed.length) {
    typed.length -= second.erase;
  } else {
    erase += second.erase - typed.length;
    typed.length = 0;
  }
  return { erase, insert: typed.join('') + second.insert };
}

/** Um passo do que vai ao PC: um trecho de texto ou uma tecla (Enter e Tab nunca viajam como texto). */
export type TextStep =
  { readonly kind: 'text'; readonly text: string } | { readonly kind: 'key'; readonly key: PcKey };

/**
 * Parte o que foi digitado em passos que o contrato aceita: o texto sai em pedaços de até `MAX_TEXT` pontos de código;
 * uma quebra de linha vira a tecla Enter e um Tab, a tecla Tab (o contrato proíbe controle no texto); os outros
 * caracteres de controle são descartados.
 */
export function textSteps(insert: string): TextStep[] {
  const steps: TextStep[] = [];
  let run = '';
  const flush = () => {
    let rest = run;
    run = '';
    while (rest.length > 0) {
      const chunk = clampText(rest, MAX_TEXT);
      steps.push({ kind: 'text', text: chunk });
      rest = rest.slice(chunk.length);
    }
  };
  let skipLineFeed = false;
  for (const char of insert) {
    // "\r\n" é uma quebra só.
    if (char === '\n' && skipLineFeed) {
      skipLineFeed = false;
      continue;
    }
    skipLineFeed = char === '\r';
    if (char === '\n' || char === '\r') {
      flush();
      steps.push({ kind: 'key', key: 'ENTER' });
    } else if (char === '\t') {
      flush();
      steps.push({ kind: 'key', key: 'TAB' });
    } else if (!/\p{Cc}/u.test(char)) {
      run += char;
    }
  }
  flush();
  return steps;
}

/** O que a digitação ao vivo pede ao PC (o `PcStore` já guarda a ordem e o prazo de cada pedido). */
export interface TyperSender {
  key(key: PcKey, modifiers: readonly PcModifier[]): Promise<PcFailure | null>;
  text(text: string): Promise<PcFailure | null>;
}

export interface TyperEvents {
  /** O envio falhou: o que esperava na fila foi descartado (o campo precisa recomeçar do que o PC tem). */
  failed(failure: PcFailure): void;
  /** A fila esvaziou e nada está a caminho. */
  idle(): void;
}

type Op =
  | { readonly kind: 'edit'; readonly diff: TextDiff }
  | { readonly kind: 'key'; readonly key: PcKey; readonly modifiers: readonly PcModifier[] };

/**
 * Ordena tudo o que vai ao PC pela digitação ao vivo e pelas teclas da tela. Um passo por vez em voo; enquanto ele não
 * volta, o que se digita se **junta** (as diferenças seguidas viram uma só, e quem apaga o que ainda não saiu o cancela
 * antes de sair). Teclas ficam entre as diferenças, na ordem em que foram pedidas, então um Enter nunca passa na frente do
 * texto que a pessoa digitou antes dele. Falhou um passo: o resto da fila é descartado (não se digita "def" depois de "abc"
 * ter falhado) e quem usa recomeça do que o PC tem.
 *
 * Com o contrato atual cada apagar é uma tecla: `erase` apagar custam `erase` pedidos em série.
 */
export class LiveTyper {
  private queue: Op[] = [];
  private running = false;
  private generation = 0;

  constructor(
    private readonly sender: TyperSender,
    private readonly events: TyperEvents,
  ) {}

  /** Pedidos na fila mais o que está em voo (a repetição de tecla espera por este número). */
  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** O campo mudou. */
  edit(diff: TextDiff): void {
    if (diff.erase === 0 && diff.insert === '') return;
    const last = this.queue.at(-1);
    if (last?.kind === 'edit') {
      this.queue[this.queue.length - 1] = { kind: 'edit', diff: mergeDiff(last.diff, diff) };
    } else {
      this.queue.push({ kind: 'edit', diff });
    }
    void this.pump();
  }

  key(key: PcKey, modifiers: readonly PcModifier[] = []): void {
    this.queue.push({ kind: 'key', key, modifiers });
    void this.pump();
  }

  /** Descarta o que ainda não saiu (a tela foi fechada); o passo em voo termina sozinho. */
  clear(): void {
    this.queue = [];
    this.generation++;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      while (this.queue.length > 0 && generation === this.generation) {
        const op = this.queue.shift()!;
        const failure = await this.run(op, generation);
        if (failure !== null && generation === this.generation) {
          this.queue = [];
          this.generation++;
          this.events.failed(failure);
          break;
        }
      }
    } finally {
      this.running = false;
    }
    if (this.queue.length === 0 && generation === this.generation) this.events.idle();
  }

  private async run(op: Op, generation: number): Promise<PcFailure | null> {
    if (op.kind === 'key') return this.sender.key(op.key, op.modifiers);
    for (let erased = 0; erased < op.diff.erase; erased++) {
      if (generation !== this.generation) return null;
      const failure = await this.sender.key('BACKSPACE', []);
      if (failure) return failure;
    }
    for (const step of textSteps(op.diff.insert)) {
      if (generation !== this.generation) return null;
      const failure =
        step.kind === 'key'
          ? await this.sender.key(step.key, [])
          : await this.sender.text(step.text);
      if (failure) return failure;
    }
    return null;
  }
}
