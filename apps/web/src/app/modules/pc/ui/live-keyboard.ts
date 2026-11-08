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
import { PcInput, type InputKind } from '../data/pc-input';
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
    <input
      #field
      type="text"
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
      (compositionend)="composing = false"
      (focus)="onFocus()"
    />
  `,
  styleUrl: './live-keyboard.css',
})
export class PcLiveKeyboard {
  private readonly store = inject(PcStore);
  private readonly input = inject(PcInput);
  private readonly armed = inject(PcArmed);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  readonly disabled = input(false);
  /** O modo teclado ligou ou desligou (o botão do teclado abriu ou fechou o campo). */
  readonly typing = output<boolean>();
  /**
   * Um aviso para a tela mostrar por um instante. Só o que o aviso de falha da tela não diz: a falha em si (o motivo) já está
   * lá; aqui entra "parte do texto pode não ter chegado" ou "não foi enviado".
   */
  readonly failed = output<string>();

  protected composing = false;
  /** O modo teclado: ligado pelo botão do teclado e desligado por ele. O campo perder o foco não o desliga. */
  private wanted = false;
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
    const stopFailure = this.input.onFailure((failure, kind) => this.onFailure(failure, kind));
    const stopIdle = this.input.onIdle(() => this.refill());
    inject(DestroyRef).onDestroy(() => {
      stopFailure();
      stopIdle();
    });
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
      this.typing.emit(true);
    }
    this.field().nativeElement.focus();
  }

  close(): void {
    if (this.wanted) {
      this.wanted = false;
      this.typing.emit(false);
    }
    this.field().nativeElement.blur();
  }

  /**
   * Tocar numa tecla da tela tira o foco do campo (e fecha o teclado do celular). No modo teclado, o foco volta já, no
   * mesmo toque, e o teclado segue aberto para a pessoa continuar digitando.
   */
  restore(): void {
    if (this.wanted && !this.focused) this.field().nativeElement.focus();
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
    else if (key === 'ENTER' || key === 'TAB') this.reset();
    this.input.sendKey(key, modifiers);
  }

  /**
   * O envio falhou: sem texto guardado para devolver, o campo recomeça do que o PC tem. A tela é avisada do que o aviso de
   * falha dela não diz (o motivo já está lá).
   */
  private onFailure(failure: PcFailure, kind: InputKind): void {
    if (kind === 'edit') this.reset();
    if (failure.kind === 'cancelled') this.failed.emit(this.notSent);
    else if (kind === 'edit' && UNCERTAIN_FAILURES.has(failure.kind))
      this.failed.emit(this.maybeLost);
    else if (!NOTED_FAILURES.has(failure.kind)) this.failed.emit(failure.message);
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
      return;
    }
    // Modificador não vale para texto: qualquer outro texto vai inteiro e as armadas se soltam do mesmo jeito.
    this.armed.clear();
    this.mirror = after;
    this.lastValue = field.value;
    this.input.edit(diff);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.press('ENTER');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.press('TAB');
    } else if (event.key === 'Backspace' && this.caretAtStart()) {
      event.preventDefault();
      this.input.sendKey('BACKSPACE', this.armed.take());
    }
  }

  /** Teclados de celular nem sempre mandam `keydown` com o nome da tecla: o `beforeinput` cobre Enter e apagar com o campo vazio. */
  protected onBeforeInput(event: Event): void {
    const type = (event as InputEvent).inputType;
    if (type === 'insertLineBreak' || type === 'insertParagraph') {
      event.preventDefault();
      this.press('ENTER');
    } else if (type === 'deleteContentBackward' && this.caretAtStart() && !this.composing) {
      event.preventDefault();
      this.input.sendKey('BACKSPACE', this.armed.take());
    }
  }

  protected onFocus(): void {
    this.reset();
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

  /** O campo volta ao preenchimento e à base que o PC tem. */
  private reset(): void {
    this.setValue(SENTINEL);
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
