import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LoadingFrame } from './loading-frame';
import { Skeleton } from './skeleton';

/**
 * As formas de espera que as telas de Configurações e Dispositivos têm em comum:
 * - `cards`: um cartão por item, com duas linhas (pessoas, passkeys, TVs, aparelhos);
 * - `group`: uma lista de linhas dentro de um só grupo, com o selo e a seta da linha (auditoria);
 * - `options`: um grupo de linhas com o nome e um controle ao lado, na altura do toque (as folhas que listam pessoas e apps);
 * - `metrics`: ladrilhos de duas colunas com rótulo, valor e detalhe (saúde do sistema);
 * - `log`: o bloco de texto corrido do registro do agente;
 * - `groups`: grupos com título e campos (rótulo e caixa), como os da configuração do sistema;
 * - `qr`: o quadrado do QR de entrada.
 */
export type LoadingKind = 'cards' | 'group' | 'options' | 'metrics' | 'log' | 'groups' | 'qr';

/**
 * Mantém ocupado o mesmo espaço do que está chegando, para a tela não pular quando o dado entra. A moldura
 * (`LoadingFrame`) cuida do resto: só se mostra se a espera passar de uma fração de segundo, o leitor de tela ouve um
 * texto só, e passado o teto vira um aviso com "Tentar de Novo" (`retried`, ou recarregar a página).
 */
@Component({
  selector: 'app-loading-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label()" [reload]="reload()" (retried)="retried.emit()">
      <div class="content" [attr.data-kind]="kind()">
        @switch (kind()) {
          @case ('cards') {
            @for (row of items(); track row) {
              <div class="card ui-card">
                <span appSkeleton class="line wide"></span>
                <span appSkeleton class="line"></span>
              </div>
            }
          }
          @case ('group') {
            <div class="group ui-group">
              @for (row of items(); track row) {
                <div class="row">
                  <span class="lines">
                    <span appSkeleton class="line wide"></span>
                    <span appSkeleton class="line"></span>
                  </span>
                  <span appSkeleton class="chip"></span>
                  <span appSkeleton class="chevron"></span>
                </div>
              }
            </div>
          }
          @case ('options') {
            <div class="group ui-group">
              @for (row of items(); track row) {
                <div class="option">
                  <span appSkeleton class="line wide"></span>
                  <span appSkeleton class="control"></span>
                </div>
              }
            </div>
          }
          @case ('metrics') {
            <div class="tiles">
              @for (row of items(); track row) {
                <div class="tile">
                  <span appSkeleton class="line small"></span>
                  <span appSkeleton class="line value"></span>
                  <span appSkeleton class="line small"></span>
                </div>
              }
            </div>
          }
          @case ('log') {
            <div class="log">
              @for (row of items(); track row) {
                <span appSkeleton class="line"></span>
              }
            </div>
          }
          @case ('groups') {
            @for (row of items(); track row) {
              <div class="fields ui-group">
                <span appSkeleton class="line wide"></span>
                <span appSkeleton class="line label"></span>
                <span appSkeleton class="input"></span>
                <span appSkeleton class="line label"></span>
                <span appSkeleton class="input"></span>
              </div>
            }
          }
          @case ('qr') {
            <span appSkeleton class="square"></span>
          }
        }
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .content {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .line {
      display: block;
      width: 42%;
      height: 12px;
      min-height: 0;
    }
    .line.wide {
      width: min(72%, 18rem);
      height: 16px;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: var(--space-4);
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-height: 64px;
      padding: var(--space-3) var(--space-4);
    }
    .row + .row {
      border-top: 1px solid var(--a-line);
    }
    .lines {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 10px;
    }
    .chip {
      display: block;
      width: 72px;
      height: 24px;
      min-height: 0;
      border-radius: var(--radius-pill);
    }
    .chevron {
      display: block;
      width: 20px;
      height: 20px;
      min-height: 0;
    }
    .option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      min-height: 52px;
      padding: 0 var(--space-4);
    }
    .option + .option {
      border-top: 1px solid var(--a-line);
    }
    .control {
      display: block;
      flex: none;
      width: 44px;
      height: 26px;
      min-height: 0;
      border-radius: var(--radius-pill);
    }
    .tiles {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface-2);
    }
    .tile .line {
      width: 60%;
    }
    .tile .line.small {
      width: 45%;
      height: 12px;
    }
    .tile .line.value {
      width: 70%;
      height: 18px;
    }
    .log {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm);
      background: var(--a-surface-2);
    }
    /* Larguras variadas para o texto corrido não parecer uma grade (sem número aleatório: o desenho é estável). */
    .log .line {
      width: 90%;
      height: 12px;
    }
    .log .line:nth-child(3n + 2) {
      width: 72%;
    }
    .log .line:nth-child(3n) {
      width: 56%;
    }
    .fields {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-3);
    }
    .line.label {
      width: 55%;
    }
    .input {
      display: block;
      height: var(--tap);
      min-height: 0;
      border-radius: var(--radius-sm);
    }
    .square {
      display: block;
      align-self: center;
      width: min(100%, 13rem);
      aspect-ratio: 1;
      min-height: 0;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingSkeleton {
  readonly kind = input<LoadingKind>('cards');
  /** O que o leitor de tela ouve na espera; o padrão serve a qualquer tela. */
  readonly label = input($localize`:@@shared.loading:Carregando conteúdo…`);
  /** Sem leitura própria para refazer, "Tentar de Novo" recarrega a página. */
  readonly reload = input(true);
  readonly retried = output<void>();
  /** Quantos itens a forma repete; cada forma tem o seu padrão, o da lista que mais aparece. */
  readonly count = input<number>();

  protected readonly items = computed(() => {
    const total = this.count() ?? DEFAULT_COUNT[this.kind()];
    return Array.from({ length: total }, (_, index) => index);
  });
}

const DEFAULT_COUNT: Record<LoadingKind, number> = {
  cards: 3,
  group: 4,
  options: 3,
  metrics: 4,
  log: 6,
  groups: 2,
  qr: 1,
};
