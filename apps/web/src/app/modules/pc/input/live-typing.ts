import type { PcFailure } from '../data/pc-failure';
import {
  PC_TEXT_ERASE_CHUNK,
  type PcKey,
  type PcKeyOptions,
  type PcModifier,
  type PcTextEdit,
} from '../data/pc-types';
import { clampText } from './text-limit';

/**
 * Esperas (ms) entre as tentativas de um pedido de edição recusado por excesso de ritmo (`rate-limited`): ele nunca foi
 * executado, então repetir é seguro e a edição não fica pela metade. Passadas todas, a falha segue como qualquer outra.
 */
export const RATE_RETRY_MS: readonly number[] = [250, 500, 1_000];

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

/**
 * Uma diferença do campo vira os pedidos `pc.text.v2` que a levam ao PC, em ordem: cada pedido apaga, digita e aperta uma tecla
 * (Enter ou Tab), nesta ordem. O caso comum, uma rajada digitada (ou uma palavra trocada), é um pedido só. Vira mais de um
 * quando o apagar passa de `PC_TEXT_ERASE_CHUNK`, quando o texto passa de `MAX_TEXT`, ou quando depois de uma tecla ainda há
 * texto (o pedido não digita depois de apertar a tecla do fim).
 */
export function editRequests(diff: TextDiff): PcTextEdit[] {
  const requests: PcTextEdit[] = [];
  let erase = diff.erase;
  while (erase > PC_TEXT_ERASE_CHUNK) {
    requests.push({ erase: PC_TEXT_ERASE_CHUNK });
    erase -= PC_TEXT_ERASE_CHUNK;
  }
  let current: { erase: number; text?: string; key?: 'ENTER' | 'TAB' } = { erase };
  const flush = () => {
    if (current.erase > 0 || current.text !== undefined || current.key !== undefined) {
      requests.push({
        ...(current.erase > 0 ? { erase: current.erase } : {}),
        ...(current.text !== undefined ? { text: current.text } : {}),
        ...(current.key !== undefined ? { key: current.key } : {}),
      });
    }
    current = { erase: 0 };
  };
  for (const step of textSteps(diff.insert)) {
    if (step.kind === 'text') {
      if (current.text !== undefined || current.key !== undefined) flush();
      current.text = step.text;
    } else {
      // `textSteps` só tira Enter e Tab como tecla.
      if (current.key !== undefined) flush();
      current.key = step.key === 'TAB' ? 'TAB' : 'ENTER';
    }
  }
  flush();
  return requests;
}

/** O que a digitação ao vivo pede ao PC (o `PcStore` já guarda a ordem e o prazo de cada pedido). */
export interface TyperSender {
  /** `options` só vai quando a tecla leva `repeat` ou `action` (um toque comum chama como sempre). */
  key(
    key: PcKey,
    modifiers: readonly PcModifier[],
    options?: PcKeyOptions,
  ): Promise<PcFailure | null>;
  text(text: string): Promise<PcFailure | null>;
  /**
   * Uma edição inteira (apagar, digitar e a tecla do fim) num pedido só (`pc.text.v2`). Só existe, e só vale, com `canEdit`.
   */
  edit?(edit: PcTextEdit): Promise<PcFailure | null>;
  /** O PC entende `pc.text.v2` agora? Sem isso (agente anterior) cada apagar e cada trecho saem como sempre. */
  canEdit?(): boolean;
}

export interface TyperEvents {
  /**
   * O envio falhou: o que esperava na fila foi descartado (o campo precisa recomeçar do que o PC tem). `kind` diz o que
   * falhou: a mudança do campo (`edit`) ou uma tecla. `droppedEdits` diz que havia mudanças do campo esperando atrás e que
   * elas foram descartadas (o PC não tem esse texto, mesmo que o que falhou tenha sido uma tecla).
   */
  failed(failure: PcFailure, kind: 'edit' | 'key', droppedEdits: boolean): void;
  /** A fila esvaziou e nada está a caminho. */
  idle(): void;
}

type Op =
  | { readonly kind: 'edit'; readonly diff: TextDiff }
  | {
      readonly kind: 'key';
      readonly key: PcKey;
      readonly modifiers: readonly PcModifier[];
      readonly options?: PcKeyOptions;
    };

/**
 * Ordena tudo o que vai ao PC pela digitação ao vivo e pelas teclas da tela. Um passo por vez em voo; enquanto ele não
 * volta, o que se digita se **junta** (as diferenças seguidas viram uma só, e quem apaga o que ainda não saiu o cancela
 * antes de sair). Teclas ficam entre as diferenças, na ordem em que foram pedidas, então um Enter nunca passa na frente do
 * texto que a pessoa digitou antes dele. Falhou um passo: o resto da fila é descartado (não se digita "def" depois de "abc"
 * ter falhado) e quem usa recomeça do que o PC tem.
 *
 * Num PC que entende `pc.text.v2` a diferença do campo vai num pedido só (`editRequests`: apagar, digitar e a tecla do fim). Sem
 * isso (agente anterior), cada apagar é uma tecla: `erase` apagar custam `erase` pedidos em série.
 */
export class LiveTyper {
  private queue: Op[] = [];
  private running = false;
  private generation = 0;

  constructor(
    private readonly sender: TyperSender,
    private readonly events: TyperEvents,
    private readonly pause: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
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

  /**
   * Uma tecla na ordem da fila. `options.repeat` aperta várias vezes num pedido só; `options.action` `DOWN` segura um
   * modificador (o `DOWN` entra na fila para nunca passar na frente do texto digitado antes dele).
   */
  key(key: PcKey, modifiers: readonly PcModifier[] = [], options?: PcKeyOptions): void {
    this.queue.push(
      options === undefined
        ? { kind: 'key', key, modifiers }
        : { kind: 'key', key, modifiers, options },
    );
    void this.pump();
  }

  /** Tira da fila as teclas que ainda não saíram (o passo em voo termina sozinho); o resto da fila segue como está. */
  discardKeys(keys: readonly PcKey[]): void {
    this.queue = this.queue.filter((op) => op.kind !== 'key' || !keys.includes(op.key));
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
          const droppedEdits = this.queue.some((waiting) => waiting.kind === 'edit');
          this.queue = [];
          this.generation++;
          this.events.failed(failure, op.kind, droppedEdits);
          break;
        }
      }
    } finally {
      this.running = false;
    }
    // O `clear()` com um passo em voo deixa a fila nova sem quem a puxe (o `pump` em curso saiu pela troca de geração): recomeça.
    if (this.queue.length > 0) {
      void this.pump();
      return;
    }
    if (generation === this.generation) this.events.idle();
  }

  /**
   * Um pedido de edição. Se o ritmo o recusou (nunca foi executado), repete depois de uma espera: uma edição grande tem vários
   * pedidos, e largar o segundo deixaria o texto do PC pela metade.
   */
  private async sendEdit(
    edit: (request: PcTextEdit) => Promise<PcFailure | null>,
    request: PcTextEdit,
    generation: number,
  ): Promise<PcFailure | null> {
    let failure = await edit(request);
    for (const wait of RATE_RETRY_MS) {
      if (failure?.kind !== 'rate-limited') break;
      await this.pause(wait);
      if (generation !== this.generation) return null;
      failure = await edit(request);
    }
    return failure;
  }

  private async run(op: Op, generation: number): Promise<PcFailure | null> {
    if (op.kind === 'key') {
      return op.options === undefined
        ? this.sender.key(op.key, op.modifiers)
        : this.sender.key(op.key, op.modifiers, op.options);
    }
    if (this.sender.edit !== undefined && this.sender.canEdit?.() === true) {
      for (const request of editRequests(op.diff)) {
        if (generation !== this.generation) return null;
        const failure = await this.sendEdit(
          this.sender.edit.bind(this.sender),
          request,
          generation,
        );
        if (failure) return failure;
      }
      return null;
    }
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
