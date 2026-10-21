import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RestTimerService } from '../data/session-live/rest-timer.service';
import { LiveStore } from './live-store';
import { clockText } from './today-text';

/**
 * O descanso entre as séries: o relógio grande, "+15 s" e "Pular". Quando acaba, o cartão vira o aviso do fim (cor cheia e o
 * texto "Descanso terminou"): o iPhone não vibra, então a tela é o aviso. O app só vibra; não toca som.
 *
 * O relógio sai do instante de fim guardado (`RestTimerService`), então voltar à aba ou recarregar mostra o tempo certo.
 */
@Component({
  selector: 'app-rest-card',
  template: `
    <section class="rest" [class.over]="timer.over()" aria-labelledby="rest-title">
      <div class="top">
        <div class="when">
          <h3 id="rest-title" class="title">
            @if (timer.over()) {
              <span i18n="@@training.live.rest-over">Descanso terminou</span>
            } @else {
              <span i18n="@@training.live.rest">Descanso</span>
            }
            @if (goal(); as meta) {
              <span class="goal" i18n="@@training.live.rest-goal">meta {{ meta }}</span>
            }
          </h3>
          <p class="clock">
            <span class="time">{{ clock() }}</span>
          </p>
        </div>
        <div class="actions">
          @if (!timer.over()) {
            <button type="button" class="ui-btn" (click)="timer.add()">
              <span i18n="@@training.live.rest-add">+15 s</span>
            </button>
          }
          <button type="button" class="ui-btn" (click)="timer.skip()">
            @if (timer.over()) {
              <span i18n="@@training.live.rest-close">Fechar</span>
            } @else {
              <span i18n="@@training.live.rest-skip">Pular</span>
            }
          </button>
        </div>
      </div>
      @if (timer.over()) {
        <p class="note" i18n="@@training.live.rest-over-note">Hora da próxima série.</p>
      } @else if (canVibrate()) {
        <p class="note" i18n="@@training.live.rest-vibrate">Vai vibrar quando terminar.</p>
      } @else {
        <p class="note" i18n="@@training.live.rest-no-vibrate">
          Este aparelho não vibra: olhe a tela quando o tempo acabar.
        </p>
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

  protected readonly clock = computed(() => clockText(this.timer.remaining()));
  /** A duração do descanso que a última série iniciou; some depois de recarregar a página (não fica guardada). */
  protected readonly goal = computed(() => {
    const seconds = this.live.restGoalS();
    return seconds === null ? null : clockText(seconds * 1000);
  });
}
