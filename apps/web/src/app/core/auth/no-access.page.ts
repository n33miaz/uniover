import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Para quem entrou mas não tem módulo nenhum liberado (o dono tirou tudo depois do convite): uma frase calma e as duas
 * saídas que existem, Perfil e Sair. É o fim da fila de "primeiro módulo que a pessoa pode usar": ninguém chega aqui por
 * um módulo que não pode abrir, e quem tem acesso a algum módulo nunca fica nesta tela (o guarda o leva embora).
 */
@Component({
  selector: 'app-no-access-page',
  imports: [RouterLink],
  template: `
    <section class="card ui-card" aria-labelledby="no-access-title">
      <h2 id="no-access-title" i18n="@@no-access.title">Nada liberado por enquanto</h2>
      <p i18n="@@no-access.text">Peça a quem convidou você para liberar.</p>
      <div class="actions">
        <a class="secondary ui-btn block" routerLink="/ajustes/perfil" i18n="@@no-access.profile"
          >Ver meu perfil</a
        >
        <button
          type="button"
          class="secondary ui-btn block"
          [disabled]="leaving()"
          (click)="logout()"
          i18n="@@no-access.logout"
        >
          Sair
        </button>
      </div>
    </section>
  `,
  styles: `
    /*
     * O cartão fica no meio da altura que a casca deixa (a tela menos o cabeçalho, o respiro do main e as áreas
     * seguras), em vez de colado no alto com dois terços da tela vazios. O cabeçalho mede uns 61px; 5rem
     * (80px) sobra de propósito: o bloco nunca passa da tela (sem rolagem à toa) e o centro cai um pouco acima do
     * meio, onde o olho espera. Sem barra de abas nesta rota, então nada mais a descontar.
     */
    :host {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-height: calc(
        100dvh - 5rem - 2 * var(--gutter) - env(safe-area-inset-top) - env(safe-area-inset-bottom)
      );
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      /* Largura cheia até o teto: sem ela, a margem automática encolheria o cartão ao tamanho do texto. */
      width: 100%;
      max-width: 40rem;
      margin-inline: auto;
      padding: var(--space-5) var(--space-4);
    }
    /* Título e frase centrados (os botões ocupam a largura toda), como nas outras telas de entrada. */
    h2 {
      font-size: var(--fs-title);
      font-weight: 750;
      letter-spacing: -0.01em;
      text-align: center;
      text-wrap: balance;
    }
    p {
      margin: 0;
      color: var(--a-ink2);
      font-size: var(--fs-small);
      text-align: center;
      text-wrap: pretty;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin-top: var(--space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoAccessPage {
  private readonly auth = inject(AuthService);
  protected readonly leaving = signal(false);

  protected async logout(): Promise<void> {
    this.leaving.set(true);
    try {
      await this.auth.logout();
    } finally {
      this.leaving.set(false);
    }
  }
}
