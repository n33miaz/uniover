import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RestTimerService } from '../data/session-live/rest-timer.service';
import { LiveStore } from './live-store';
import { clockText } from './today-text';

/**
 * O descanso entre as séries: o relógio grande, "+15 s" e os atalhos para encerrar. Quando acaba, o cartão vira o aviso
 * do fim (cor cheia e o texto "Descanso terminou"): o iPhone não vibra, então a tela é o aviso. O app só vibra; não toca som.
 *
 * O recorde que acabou de sair aparece aqui e só aqui: durante o descanso a tela não repete o aviso próprio dele.
 *
 * O relógio sai do instante de fim guardado (`RestTimerService`), então voltar à aba ou recarregar mostra o tempo certo.
 */
@Component({
  selector: 'app-rest-card',
  template: `
    <section class="rest" [class.over]="timer.over()" aria-labelledby="rest-title">
      <h3 id="rest-title" class="title">
        @if (timer.over()) {
          <span i18n="@@training.live.rest-over">Descanso terminou</span>
        } @else {
          <span i18n="@@training.live.rest">Descanso</span>
        }
      </h3>
      <p class="clock">
        <span class="time">{{ clock() }}</span>
      </p>
      @if (goal(); as meta) {
        <p class="goal" i18n="@@training.live.rest-goal">meta {{ meta }}</p>
      }
      <div class="actions">
        @if (!timer.over()) {
          <button type="button" class="secondary ui-btn add" (click)="timer.add()">
            <span i18n="@@training.live.rest-add">+15 s</span>
          </button>
        }
        <button type="button" class="primary ui-btn skip" (click)="timer.skip()">
          @if (timer.over()) {
            <span i18n="@@training.live.rest-close">Fechar</span>
          } @else {
            <span i18n="@@training.live.rest-skip">Pular Descanso</span>
          }
        </button>
      </div>
      <div class="finish">
        <button type="button" class="ghost ui-btn" (click)="finishExercise.emit()">
          <span i18n="@@training.live.rest-finish-exercise">Encerrar Exercício</span>
        </button>
        <button type="button" class="ghost ui-btn" (click)="finishWorkout.emit()">
          <span i18n="@@training.live.rest-finish-workout">Encerrar Treino</span>
        </button>
      </div>
      @if (record() || last() || nextSet()) {
        <div class="details">
          @if (record()) {
            <p class="wide">
              <span i18n="@@training.live.rest-record">Recorde</span>
              {{ record() }}
            </p>
          }
          @if (last()) {
            <p>
              <span i18n="@@training.live.rest-last">Última carga</span>
              {{ last() }}
            </p>
          }
          @if (nextSet()) {
            <p>
              <span i18n="@@training.live.rest-next">Próxima</span>
              {{ nextSet() }}
            </p>
          }
        </div>
      }
      @if (!timer.over()) {
        @if (canVibrate()) {
          <p class="note" i18n="@@training.live.rest-vibrate">Vibra no fim.</p>
        } @else {
          <p class="note" i18n="@@training.live.rest-no-vibrate">Sem vibração: olhe a tela.</p>
        }
      }
    </section>
  `,
  styleUrl: './rest-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RestCard {
  protected readonly timer = inject(RestTimerService);
  private readonly live = inject(LiveStore);

  /** O aparelho vibra? O iPhone não: o aviso do fim do descanso fica só na tela. */
  readonly canVibrate = input(false);
  /** A última carga e a próxima série ajudam sem tirar o cronômetro do centro. */
  readonly record = input<string | null>(null);
  readonly last = input<string | null>(null);
  readonly nextSet = input<string | null>(null);
  readonly finishExercise = output<void>();
  readonly finishWorkout = output<void>();

  protected readonly clock = computed(() => clockText(this.timer.remaining()));
  /** A duração do descanso que a última série iniciou; some depois de recarregar a página (não fica guardada). */
  protected readonly goal = computed(() => {
    const seconds = this.live.restGoalS();
    return seconds === null ? null : clockText(seconds * 1000);
  });
}
