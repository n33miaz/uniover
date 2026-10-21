import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingSheet } from '../shell/training-sheet';
import { TodayGlyph } from './today-glyph';

/** O que a pessoa pediu no menu do treino. */
export type MenuAction =
  'steps' | 'skip' | 'swap' | 'plan' | 'add' | 'follow' | 'finish' | 'discard';

/**
 * Folha "Opções do treino": o que não precisa estar sempre na tela. Separa o que é do exercício em foco (como fazer,
 * pular, substituir) do que é do treino (lista dos exercícios, acrescentar, terminar, cancelar) e traz o interruptor da
 * tela acesa, que nasce desligado. Cancelar o treino pede confirmação aqui mesmo.
 */
@Component({
  selector: 'app-session-menu-sheet',
  imports: [TrainingSheet, TrainingGlyph, TodayGlyph],
  template: `
    <app-training-sheet [heading]="heading" (closed)="closed.emit()">
      <div class="ui-group screen">
        <label class="ui-row">
          <span class="ui-tile"><app-today-glyph name="screen" /></span>
          <span class="ui-row-text">
            <span class="ui-row-title" i18n="@@training.menu.screen">Manter a tela acesa</span>
            <span class="ui-row-sub">{{ screenHint() }}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            class="ui-switch"
            #toggle
            [disabled]="!screenSupported()"
            (change)="onScreen($event)"
          />
        </label>
      </div>
      <p class="platform" i18n="@@training.menu.platform">
        Com a tela bloqueada o descanso continua contando, mas não avisa: ao voltar, o app mostra o
        tempo certo. No iPhone, só a tela acesa evita isso (app instalado, iOS 18.4 ou mais novo).
      </p>

      @if (hasFocus()) {
        <h3 class="ui-section-label" i18n="@@training.menu.exercise">Este exercício</h3>
        <ul class="ui-group ui-plain">
          @if (hasSteps()) {
            <li>
              <button type="button" class="ui-row" (click)="action.emit('steps')">
                <span class="ui-tile"><app-training-glyph name="info" /></span>
                <span class="ui-row-text">
                  <span class="ui-row-title" i18n="@@training.menu.steps">Como fazer</span>
                </span>
              </button>
            </li>
          }
          @if (canSwitch()) {
            <li>
              <button type="button" class="ui-row" (click)="action.emit('skip')">
                <span class="ui-tile"><app-today-glyph name="skip" /></span>
                <span class="ui-row-text">
                  <span class="ui-row-title" i18n="@@training.menu.skip">Pular exercício</span>
                  <span class="ui-row-sub" i18n="@@training.menu.skip-sub"
                    >Sai do plano de hoje; as séries feitas ficam.</span
                  >
                </span>
              </button>
            </li>
            <li>
              <button type="button" class="ui-row" (click)="action.emit('swap')">
                <span class="ui-tile"><app-today-glyph name="swap" /></span>
                <span class="ui-row-text">
                  <span class="ui-row-title" i18n="@@training.menu.swap">Substituir exercício</span>
                  <span class="ui-row-sub" i18n="@@training.menu.swap-sub"
                    >Só hoje: a rotina não muda.</span
                  >
                </span>
              </button>
            </li>
          }
        </ul>
      }

      <h3 class="ui-section-label" i18n="@@training.menu.workout">Treino</h3>
      <ul class="ui-group ui-plain">
        <li>
          <button type="button" class="ui-row" (click)="action.emit('plan')">
            <span class="ui-tile"><app-training-glyph name="list" /></span>
            <span class="ui-row-text">
              <span class="ui-row-title" i18n="@@training.menu.plan">Exercícios do treino</span>
              <span class="ui-row-sub" i18n="@@training.menu.plan-sub"
                >Voltar a um exercício ou fazer mais uma série.</span
              >
            </span>
          </button>
        </li>
        <li>
          <button type="button" class="ui-row" (click)="action.emit('add')">
            <span class="ui-tile"><app-training-glyph name="plus" /></span>
            <span class="ui-row-text">
              <span class="ui-row-title" i18n="@@training.menu.add">Adicionar exercício</span>
            </span>
          </button>
        </li>
        @if (chosen()) {
          <li>
            <button type="button" class="ui-row" (click)="action.emit('follow')">
              <span class="ui-tile"><app-training-glyph name="back" /></span>
              <span class="ui-row-text">
                <span class="ui-row-title" i18n="@@training.menu.follow">Seguir o plano</span>
              </span>
            </button>
          </li>
        }
      </ul>

      <ul class="ui-group ui-plain">
        @if (canFinish()) {
          <li>
            <button type="button" class="ui-row" (click)="action.emit('finish')">
              <span class="ui-tile ok"><app-training-glyph name="check" /></span>
              <span class="ui-row-text">
                <span class="ui-row-title" i18n="@@training.menu.finish">Terminar treino</span>
              </span>
            </button>
          </li>
        }
        <li>
          <button
            type="button"
            class="ui-row danger"
            [attr.aria-expanded]="confirming()"
            (click)="confirming.set(true)"
          >
            <span class="ui-tile bad"><app-training-glyph name="trash" /></span>
            <span class="ui-row-text">
              <span class="ui-row-title" i18n="@@training.menu.discard">Cancelar treino</span>
              <span class="ui-row-sub" i18n="@@training.menu.discard-sub"
                >Apaga o treino de hoje e as séries dele.</span
              >
            </span>
          </button>
        </li>
      </ul>
      @if (confirming()) {
        <div class="ui-notice warn" role="group" [attr.aria-label]="confirmLabel">
          <app-training-glyph name="alert" />
          <div class="confirm">
            <p i18n="@@training.menu.discard-confirm">
              Cancelar este treino? Não dá para desfazer.
            </p>
            <div class="confirm-actions">
              <button type="button" class="danger ui-btn" (click)="action.emit('discard')">
                <span i18n="@@training.menu.discard-yes">Sim, cancelar</span>
              </button>
              <button type="button" class="secondary ui-btn" (click)="confirming.set(false)">
                <span i18n="@@training.menu.discard-no">Continuar treinando</span>
              </button>
            </div>
          </div>
        </div>
      }
    </app-training-sheet>
  `,
  styleUrl: './session-menu-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionMenuSheet {
  /** Há um exercício em foco (senão as opções dele não aparecem). */
  readonly hasFocus = input(false);
  readonly hasSteps = input(false);
  /** Pular e substituir só valem para exercício da rotina. */
  readonly canSwitch = input(false);
  /** A pessoa escolheu um exercício fora do plano: aparece "Seguir o plano". */
  readonly chosen = input(false);
  /** Só se termina um treino que tem série gravada; sem série, o caminho é cancelar. */
  readonly canFinish = input(false);
  readonly screenSupported = input(false);
  readonly screenOn = input(false);
  /** O aparelho recusou a tela acesa (bateria baixa, economia de energia). */
  readonly screenRefused = input(false);

  readonly action = output<MenuAction>();
  readonly screen = output<boolean>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.menu.title:Opções do treino`;
  protected readonly confirmLabel = $localize`:@@training.menu.discard-label:Confirmar o cancelamento do treino`;
  protected readonly confirming = signal(false);
  private readonly toggle = viewChild<ElementRef<HTMLInputElement>>('toggle');

  constructor() {
    // O interruptor mostra o que o aparelho de fato fez: se a tela acesa foi recusada, ele volta a desligado.
    effect(() => {
      const on = this.screenOn();
      this.screenRefused();
      const element = this.toggle()?.nativeElement;
      if (element) element.checked = on;
    });
  }

  protected onScreen(event: Event): void {
    this.screen.emit((event.target as HTMLInputElement).checked);
  }

  protected readonly screenHint = computed(() => {
    if (!this.screenSupported()) {
      return $localize`:@@training.menu.screen-unsupported:Este navegador não permite manter a tela acesa. Deixe o bloqueio automático em "Nunca" durante o treino.`;
    }
    if (this.screenRefused()) {
      return $localize`:@@training.menu.screen-refused:O aparelho recusou agora (bateria baixa ou economia de energia). Deixe o bloqueio automático em "Nunca" durante o treino.`;
    }
    return this.screenOn()
      ? $localize`:@@training.menu.screen-on:Ligada: a tela não apaga enquanto o treino está aberto.`
      : $localize`:@@training.menu.screen-off:Desligada: a tela apaga no tempo do aparelho.`;
  });
}
