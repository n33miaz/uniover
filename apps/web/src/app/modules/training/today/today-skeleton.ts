import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * O esqueleto da aba Hoje, na ordem da tela pronta (`today-home`): a data, o cartão do dia (a primeira linha com o rótulo e
 * os três pontos, o nome, o resumo, o botão de iniciar e o "Ver Rotina") e, com `withWeek`, o cartão da semana (título e
 * setas, os sete dias, o resumo e os três números) e a ação de baixo. A página usa tudo enquanto o módulo ainda não leu
 * nada; a Início do módulo usa só o cartão do dia quando a semana (que já tem as datas) é a verdadeira.
 * `label` troca o que o leitor de tela ouve (a entrada do módulo diz que confirma a conta).
 *
 * As classes levam o prefixo `sk-` de propósito: nenhuma repete o nome de uma classe da tela pronta, para que quem procura
 * a tela de verdade (um teste, um seletor) nunca tome a forma de espera por ela.
 */
@Component({
  selector: 'app-today-skeleton',
  host: { '[class.inside]': '!withWeek()' },
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label()">
      <div class="sk-home">
        <span appSkeleton class="sk-date"></span>
        <div class="sk-card ui-card">
          <div class="sk-top">
            <span appSkeleton class="sk-eyebrow"></span>
            <span appSkeleton class="sk-dots"></span>
          </div>
          <span appSkeleton class="sk-name"></span>
          <span appSkeleton class="sk-meta"></span>
          <span appSkeleton class="sk-go"></span>
          <span appSkeleton class="sk-toggle"></span>
        </div>
        @if (withWeek()) {
          <div class="sk-week ui-card">
            <div class="sk-week-head">
              <span appSkeleton class="sk-week-title"></span>
              <span appSkeleton class="sk-week-nav"></span>
            </div>
            <div class="sk-week-days">
              @for (day of days; track day) {
                <span appSkeleton class="sk-day"></span>
              }
            </div>
            <span appSkeleton class="sk-meta"></span>
            <div class="sk-stats">
              @for (stat of stats; track stat) {
                <span appSkeleton class="sk-stat"></span>
              }
            </div>
          </div>
          <span appSkeleton class="sk-free"></span>
        }
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    /* As medidas repetem as de today-home.css e week-calendar.css: o que chega depois ocupa o mesmo lugar. */
    .sk-home {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      max-width: 40rem;
      margin-inline: auto;
      padding-block-start: var(--space-2);
    }
    /* Só o cartão do dia já vive dentro do contêiner da tela pronta, que dá a margem e a largura: aqui não se repete. */
    :host(.inside) .sk-home {
      max-width: none;
      padding-block-start: 0;
    }
    .sk-date {
      display: block;
      width: 9rem;
      height: 14px;
      min-height: 0;
      margin-inline: var(--space-1);
    }
    .sk-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-4);
    }
    .sk-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      min-height: var(--tap);
      margin-block: calc(var(--space-3) * -1) calc(var(--space-5) * -1);
    }
    .sk-eyebrow {
      display: block;
      width: 30%;
      height: 12px;
      min-height: 0;
    }
    .sk-dots {
      display: block;
      width: 28px;
      height: 28px;
      min-height: 0;
      border-radius: 50%;
    }
    .sk-name {
      display: block;
      width: 60%;
      height: 20px;
      min-height: 0;
    }
    .sk-meta {
      display: block;
      width: 55%;
      height: 14px;
      min-height: 0;
    }
    .sk-go {
      display: block;
      height: 44px;
      min-height: 0;
      border-radius: var(--radius);
    }
    .sk-toggle {
      display: block;
      align-self: center;
      width: 7rem;
      height: 16px;
      min-height: 0;
      margin-block: calc((var(--tap) - 16px) / 2);
    }
    .sk-week {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-3);
    }
    .sk-week-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 24px;
    }
    .sk-week-title {
      display: block;
      width: 40%;
      height: 18px;
      min-height: 0;
    }
    .sk-week-nav {
      display: block;
      width: 5.5rem;
      height: 24px;
      min-height: 0;
      border-radius: var(--radius-pill);
    }
    .sk-week-days {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 3px;
    }
    .sk-day {
      display: block;
      height: 66px;
      min-height: 0;
      border-radius: var(--radius-sm);
    }
    .sk-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .sk-stat {
      display: block;
      height: 38px;
      min-height: 0;
    }
    .sk-free {
      display: block;
      height: var(--tap);
      min-height: 0;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TodaySkeleton {
  readonly withWeek = input(false);
  readonly label = input($localize`:@@training.today.loading:Carregando o treino do dia…`);

  protected readonly days = [1, 2, 3, 4, 5, 6, 7];
  protected readonly stats = [1, 2, 3];
}
