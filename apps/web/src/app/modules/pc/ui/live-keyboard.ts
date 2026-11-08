import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { PcArmed } from '../data/pc-armed';
import type { PcFailure } from '../data/pc-failure';
import { MAX_KEYS_IN_FLIGHT, PcInput, type InputKind } from '../data/pc-input';
import { PcStore } from '../data/pc-store';
import type { PcKey, PcLetter, PcModifier } from '../data/pc-types';
import { tick } from '../input/haptics';
import { PADDING_CHAR, fieldDiff, fieldState, type FieldState } from '../input/live-typing';

/**
 * O que o campo escondido guarda antes de qualquer coisa digitada: alguns espaços de largura zero. Sem eles, apagar com o
 * campo vazio não geraria evento nenhum e a tecla Backspace não chegaria ao PC. São invisíveis e não formam palavra.
 * NÃO VERIFICADO no iPhone nem no Gboard: se o Backspace com o campo vazio falhar lá, o `beforeinput` é o plano B.
 */
export const SENTINEL = PADDING_CHAR.repeat(6);

/** Abaixo disto de caracteres de preenchimento a mais, o campo é refeito quando fica em silêncio. */
const MIN_SENTINEL = 2;
/** O campo não cresce sem fim: passou disto, é refeito no próximo silêncio (o PC já tem o texto). */
const MAX_FIELD = 150;

/**
 * Falhas em que o texto pode ter sido digitado, ao menos em parte: o campo não o recebe de volta (não há texto guardado).
 * `failed` é a recusa do sistema do PC no meio do envio (o Windows aceita só os primeiros eventos de um lote).
 */
const UNCERTAIN_FAILURES: ReadonlySet<string> = new Set([
  'timeout',
  'network',
  'unknown',
  'failed',
]);

/** Falhas que a tela já mostra pelo aviso de falha do `PcStore` (o motivo); as outras o campo mostra. */
const NOTED_FAILURES: ReadonlySet<string> = new Set([
  'timeout',
  'network',
  'unknown',
  'failed',
  'session',
  'forbidden',
  'rate-limited',
  'invalid',
  'not-found',
  'reconnecting',
]);

/**
 * A digitação ao vivo: um campo escondido que recebe o teclado do celular, e cada mudança dele vai ao PC na hora, sem
 * botão de enviar. Mostra nada e guarda nada (pode ser uma senha). Cada mudança vira "apagar n, digitar o resto" por pontos de
 * código; enquanto um pedido está em voo o que se digita se junta num só (`LiveTyper`). Enter e Tab saem como tecla, nunca
 * como texto. Toda tecla da tela (barra de ações, painel, atalhos) passa por aqui também, para nunca ultrapassar o texto
 * digitado antes dela. O campo recebe o foco no toque do botão do teclado (no iOS o teclado só abre dentro do toque).
 */
@Component({
  selector: 'app-pc-live-keyboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <textarea
      #field
      rows="1"
      class="field"
      autocomplete="off"
      [attr.autocapitalize]="'off'"
      [attr.autocorrect]="'off'"
      spellcheck="false"
      [attr.enterkeyhint]="'enter'"
      aria-label="Digitar no PC"
      i18n-aria-label="@@pc.live.field"
      [disabled]="disabled()"
      (input)="onInput()"
      (keydown)="onKeydown($event)"
      (beforeinput)="onBeforeInput($event)"
      (compositionstart)="composing = true"
      (compositionend)="onCompositionEnd()"
      (focus)="onFocus()"
      (blur)="onBlur()"
    ></textarea>
  `,
  styleUrl: './live-keyboard.css',
})
export class PcLiveKeyboard {
  private readonly store = inject(PcStore);
  private readonly input = inject(PcInput);
  private readonly armed = inject(PcArmed);
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  readonly disabled = input(false);
  /** O modo teclado ligou ou desligou (o botão do teclado abriu ou fechou o campo). */
  readonly typing = output<boolean>();
  /**
   * Um aviso para a tela mostrar por um instante. Só o que o aviso de falha da tela não diz: a falha em si (o motivo) já está
   * lá; aqui entra "parte do texto pode não ter chegado" ou "não foi enviado".
   */
  readonly failed = output<string>();

  protected composing = false;
  private readonly doc = inject(DOCUMENT);
  /**
   * O modo teclado: ligado pelo botão do teclado e desligado por ele, ou quando o sistema fecha o teclado (voltar do
   * Android, "Concluído" do iOS) ou o foco vai para outro lugar. Tocar nas teclas da tela tira o foco do campo por um
   * instante (ver `holdFocus`) e não conta.
   */
  private wanted = false;
  /**
   * Um toque nas teclas da tela está em curso (do `pointerdown` ao fim do toque ou ao clique): a perda de foco que vem junto
   * não é o sistema. Segurar Apagar ou uma seta por muito tempo não pode fechar o teclado.
   */
  private holding = false;
  /** Pediram para recomeçar o campo durante uma composição: espera o fim dela (recomeçar no meio a corromperia). */
  private resetPending = false;
  /** A largura da janela na última medida (mudou: o aparelho girou). */
  private lastWidth = 0;
  /** A maior altura da janela vista sem o teclado: a base para saber que o teclado do sistema abriu e fechou. */
  private fullHeight = 0;
  /** A janela já encolheu com o teclado aberto: a próxima volta ao tamanho cheio é o sistema fechando o teclado. */
  private shrunk = false;
  /** Quando foi o último Backspace do teclado do celular (a repetição de segurar usa o mesmo freio da barra). */
  private lastPhoneBackspace = 0;
  /** O que o campo mostrava na última vez que o PC foi posto em dia: a base da próxima diferença. */
  private mirror: FieldState = fieldState(SENTINEL);
  /** O valor do campo logo depois (para desfazer uma letra que virou atalho). */
  private lastValue = SENTINEL;

  private readonly maybeLost = $localize`:@@pc.live.maybe-lost:Parte do texto pode não ter chegado.`;
  private readonly notSent = $localize`:@@pc.live.not-sent:O texto não foi enviado.`;

  constructor() {
    afterNextRender(() => this.reset());
    // Sem PC o campo desliga e o teclado fecha: o modo teclado acaba.
    effect(() => {
      if (this.disabled() && this.wanted) {
        this.wanted = false;
        this.typing.emit(false);
      }
    });
    // A fila é do app, não desta tela: o que ainda não saiu segue saindo ao trocar de aba. Aqui só se ouve falha e silêncio.
    const stopFailure = this.input.onFailure((failure, kind, dropped) =>
      this.onFailure(failure, kind, dropped),
    );
    const stopIdle = this.input.onIdle(() => this.refill());
    // Um atalho (ou uma tecla com modificador) mexeu no texto do PC por fora: o campo recomeça do que o PC tem.
    const stopDiverge = this.input.onDiverge(() => this.reset());
    const viewport = this.doc.defaultView?.visualViewport ?? null;
    this.fullHeight = viewport?.height ?? 0;
    const onViewport = () => this.watchViewport(viewport!.height);
    viewport?.addEventListener('resize', onViewport);
    const win = this.doc.defaultView;
    this.lastWidth = win?.innerWidth ?? 0;
    // Girar o aparelho muda a altura "cheia": a base é medida de novo (a janela cresce ou encolhe sem teclado nenhum).
    let rotation: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if ((win?.innerWidth ?? 0) !== this.lastWidth) this.recalibrate();
    };
    const onRotate = () => {
      clearTimeout(rotation);
      rotation = setTimeout(() => this.recalibrate(), 350);
    };
    win?.addEventListener('resize', onResize);
    win?.addEventListener('orientationchange', onRotate);
    inject(DestroyRef).onDestroy(() => {
      stopFailure();
      stopIdle();
      stopDiverge();
      viewport?.removeEventListener('resize', onViewport);
      win?.removeEventListener('resize', onResize);
      win?.removeEventListener('orientationchange', onRotate);
      clearTimeout(rotation);
      this.releaseHold();
    });
  }

  /** O modo teclado está ligado (o botão do teclado aparece apertado). */
  get active(): boolean {
    return this.wanted;
  }

  /**
   * Chamar no começo de um toque nas teclas da tela: a perda de foco que vem junto não é o sistema fechando o teclado, e o
   * foco volta no clique (`restore`). Vale até o toque terminar (soltar ou cancelar) ou o clique, e não por um tempo fixo.
   */
  holdFocus(): void {
    if (this.holding) return;
    this.holding = true;
    const win = this.doc.defaultView;
    const end = () => {
      win?.removeEventListener('pointerup', end, true);
      win?.removeEventListener('pointercancel', end, true);
      // O clique vem logo depois de soltar: ele devolve o foco antes de a proteção acabar.
      setTimeout(() => this.releaseHold(), 0);
    };
    this.stopHolding = end;
    win?.addEventListener('pointerup', end, true);
    win?.addEventListener('pointercancel', end, true);
  }

  private stopHolding: (() => void) | null = null;

  private releaseHold(): void {
    this.holding = false;
    const win = this.doc.defaultView;
    if (this.stopHolding) {
      win?.removeEventListener('pointerup', this.stopHolding, true);
      win?.removeEventListener('pointercancel', this.stopHolding, true);
    }
    this.stopHolding = null;
  }

  /** Teclas pedidas e ainda sem resposta (a repetição de apagar e das setas espera por este número). */
  get pending(): number {
    return this.input.pending;
  }

  /** O teclado do celular está aberto agora (o campo tem o foco). */
  get focused(): boolean {
    const field = this.field().nativeElement;
    return field.ownerDocument.activeElement === field;
  }

  /** Abre o teclado do celular. Chamar dentro do manipulador do toque (no iOS, fora dele o teclado não abre). */
  open(): void {
    if (!this.wanted) {
      this.wanted = true;
      this.shrunk = false;
      this.typing.emit(true);
    }
    this.field().nativeElement.focus();
  }

  close(): void {
    this.endMode();
    this.field().nativeElement.blur();
  }

  /**
   * Tocar numa tecla da tela tira o foco do campo (e fecha o teclado do celular). No modo teclado, o foco volta já, no
   * mesmo toque, e o teclado segue aberto para a pessoa continuar digitando.
   */
  restore(): void {
    if (this.wanted && !this.focused) this.field().nativeElement.focus();
    // O clique é o fim do toque nas teclas da tela.
    this.releaseHold();
  }

  /**
   * Uma tecla da tela. As armadas valem para ela e se soltam. Apagar com texto no campo tira também o último ponto de
   * código do campo (o campo e o PC seguem iguais); Enter e Tab recomeçam o campo.
   */
  press(key: PcKey, extra: readonly PcModifier[] = []): void {
    if (!this.store.canSend()) return;
    tick();
    const modifiers = this.armed.take(extra);
    if (key === 'BACKSPACE' && modifiers.length === 0) this.dropLast();
    // Enter e Tab, e qualquer tecla com modificador (Ctrl+Z, Ctrl+Backspace...), mexem no texto do PC por fora do campo.
    else if (key === 'ENTER' || key === 'TAB' || modifiers.length > 0) this.reset();
    this.input.sendKey(key, modifiers);
  }

  /**
   * O Backspace do teclado do celular: o mesmo da tecla da barra (as armadas valem para ele; com modificador o campo
   * recomeça). Segurar repete, e a repetição pula a rodada com teclas demais sem resposta, como na barra.
   */
  private phoneBackspace(repeating: boolean): void {
    const now = Date.now();
    const rapid = repeating || now - this.lastPhoneBackspace < 200;
    this.lastPhoneBackspace = now;
    if (rapid && this.input.pending >= MAX_KEYS_IN_FLIGHT) return;
    if (!this.store.canSend()) return;
    tick();
    const modifiers = this.armed.take();
    this.input.sendKey('BACKSPACE', modifiers);
    if (modifiers.length > 0) this.reset();
  }

  /** O modo teclado acaba (o botão do teclado volta ao normal). */
  private endMode(): void {
    if (!this.wanted) return;
    this.wanted = false;
    this.typing.emit(false);
  }

  /** A janela encolheu (o teclado do sistema abriu) e voltou ao tamanho cheio (o sistema o fechou): o modo teclado acaba. */
  private watchViewport(height: number): void {
    if (!this.wanted) {
      this.fullHeight = height;
      return;
    }
    if (height < this.fullHeight - 120) {
      this.shrunk = true;
    } else if (
      (this.shrunk && height >= this.fullHeight - 80) ||
      // A base ficou baixa (o aparelho girou com o teclado aberto) e a janela cresceu: o teclado fechou.
      height > this.fullHeight + 120
    ) {
      this.shrunk = false;
      this.fullHeight = height;
      this.endMode();
      this.field().nativeElement.blur();
    }
  }

  /** O aparelho girou (ou a janela mudou de largura): a altura "cheia" de antes não vale mais. */
  private recalibrate(): void {
    const win = this.doc.defaultView;
    if (!win) return;
    this.lastWidth = win.innerWidth;
    this.shrunk = false;
    const viewport = win.visualViewport;
    // Sem teclado, a base é a altura de agora; com ele aberto, a maior das duas que o navegador informa.
    this.fullHeight = this.wanted
      ? Math.max(viewport?.height ?? 0, win.innerHeight)
      : (viewport?.height ?? win.innerHeight);
  }

  /**
   * O envio falhou: sem texto guardado para devolver, o campo recomeça do que o PC tem. A tela é avisada do que o aviso de
   * falha dela não diz (o motivo já está lá).
   */
  private onFailure(failure: PcFailure, kind: InputKind, droppedEdits: boolean): void {
    // Falhou uma tecla e o que se digitou depois dela foi descartado: o PC não tem esse texto, então o campo recomeça igual.
    if (kind === 'edit' || droppedEdits) this.reset();
    if (failure.kind === 'cancelled' || (droppedEdits && kind === 'key')) {
      this.failed.emit(this.notSent);
    } else if (kind === 'edit' && UNCERTAIN_FAILURES.has(failure.kind)) {
      this.failed.emit(this.maybeLost);
    } else if (!NOTED_FAILURES.has(failure.kind)) this.failed.emit(failure.message);
  }

  protected onInput(): void {
    const field = this.field().nativeElement;
    const { diff, after } = fieldDiff(this.mirror, field.value);
    if (diff.erase === 0 && diff.insert === '') {
      this.mirror = after;
      this.lastValue = field.value;
      return;
    }
    const armed = this.armed.armed();
    // Com uma tecla armada, uma letra sozinha é o atalho (Ctrl armado e "c" é Ctrl+C), não texto: sai como tecla e some do campo.
    if (armed.size > 0 && diff.erase === 0 && /^[a-z]$/i.test(diff.insert)) {
      field.value = this.lastValue;
      this.input.sendKey(diff.insert.toUpperCase() as PcLetter, this.armed.take());
      // Ctrl+A, Ctrl+V, Ctrl+Z...: o texto do PC mudou por fora do campo.
      this.reset();
      return;
    }
    // Apagar com uma tecla armada (Ctrl+Backspace) é a tecla da barra: sai como tecla com o modificador, não como texto.
    if (armed.size > 0 && diff.insert === '' && diff.erase > 0) {
      this.phoneBackspace(false);
      return;
    }
    // Modificador não vale para texto: qualquer outro texto vai inteiro e as armadas se soltam do mesmo jeito.
    this.armed.clear();
    this.mirror = after;
    this.lastValue = field.value;
    this.input.edit(diff);
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Durante a composição (predição do teclado do celular) as teclas são do teclado, não do PC.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.press('ENTER');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.press('TAB');
    } else if (event.key === 'Backspace' && this.caretAtStart()) {
      event.preventDefault();
      this.phoneBackspace(event.repeat);
    }
  }

  /** Teclados de celular nem sempre mandam `keydown` com o nome da tecla: o `beforeinput` cobre Enter e apagar com o campo vazio. */
  protected onBeforeInput(event: Event): void {
    const { inputType: type, isComposing } = event as InputEvent;
    if ((type === 'insertLineBreak' || type === 'insertParagraph') && !isComposing) {
      event.preventDefault();
      this.press('ENTER');
    } else if (type === 'deleteContentBackward' && this.caretAtStart() && !this.composing) {
      event.preventDefault();
      this.phoneBackspace(false);
    }
  }

  protected onFocus(): void {
    this.reset();
  }

  /** O foco saiu do campo: se não foi um toque nas teclas da tela, o teclado do celular foi fechado (ou o foco foi para outro lugar). */
  protected onBlur(): void {
    if (this.wanted && !this.holding) this.endMode();
  }

  private caretAtStart(): boolean {
    const field = this.field().nativeElement;
    return field.selectionStart === 0 && field.selectionEnd === 0;
  }

  /** Tira do campo o último caractere digitado (ou, sem texto, um de preenchimento), como o Backspace da tela fez no PC. */
  private dropLast(): void {
    const points = Array.from(this.field().nativeElement.value);
    let index = points.length - 1;
    while (index >= 0 && points[index] === PADDING_CHAR) index--;
    // Sem texto digitado, o que sai é um caractere de preenchimento.
    if (index < 0) index = points.length - 1;
    if (index < 0) return;
    points.splice(index, 1);
    this.setValue(points.join(''));
  }

  /**
   * O campo volta ao preenchimento e à base que o PC tem. Durante uma composição (o teclado do celular montando uma palavra)
   * espera o fim dela: trocar o valor no meio a estragaria.
   */
  private reset(): void {
    if (this.composing) {
      this.resetPending = true;
      return;
    }
    this.resetPending = false;
    this.setValue(SENTINEL);
  }

  protected onCompositionEnd(): void {
    this.composing = false;
    if (!this.resetPending) return;
    // O `input` final da composição pode chegar depois deste evento: ele é processado primeiro e só então o campo recomeça.
    setTimeout(() => {
      if (this.resetPending && !this.composing) this.reset();
    }, 0);
  }

  private setValue(value: string): void {
    const field = this.field().nativeElement;
    field.value = value;
    this.mirror = fieldState(value);
    this.lastValue = value;
    field.setSelectionRange?.(value.length, value.length);
  }

  /** Em silêncio (nada na fila): se o preenchimento acabou ou o campo cresceu demais, ele é refeito. */
  private refill(): void {
    if (this.composing) return;
    const value = this.field().nativeElement.value;
    if (value === SENTINEL) return;
    if (fieldState(value).padding >= MIN_SENTINEL && Array.from(value).length <= MAX_FIELD) return;
    this.reset();
  }
}
