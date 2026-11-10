import { Component, computed, inject, input } from '@angular/core';
import { CommandModule, SlowCommandWatch } from './slow-command';

/**
 * O aviso de "comando sem resposta" de um módulo (ver `SlowCommandWatch`). Por padrão flutua sobre a base da tela sem pegar o
 * toque, como o aviso passageiro da TV, para o controle seguir usável; `inline` o põe no fluxo da página (dentro de uma
 * folha, por exemplo). A distância da base vem de `--slow-bottom` (já somada a área segura) para a tela que tem uma barra fixa embaixo. A saída
 * (`animate.leave`) segura o elemento até o fim da animação; por isso a decisão de mostrar fica aqui dentro.
 */
@Component({
  selector: 'app-slow-command-notice',
  template: `
    @if (slow()) {
      <p class="slow" [class.inline]="inline()" role="status" [animate.leave]="'slow-leave'">
        @switch (module()) {
          @case ('tv') {
            <span i18n="@@slow-command.tv">A TV não está respondendo.</span>
          }
          @case ('pc') {
            <span i18n="@@slow-command.pc">O PC não está respondendo.</span>
          }
          @default {
            <span i18n="@@slow-command.server">O servidor não está respondendo.</span>
          }
        }
      </p>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .slow {
      position: fixed;
      right: var(--gutter);
      bottom: calc(var(--slow-bottom, calc(var(--gutter) + var(--safe-bottom))) + var(--kb-inset));
      left: var(--gutter);
      z-index: 5;
      max-width: 36rem;
      margin: 0 auto;
      padding: 10px 14px;
      border: 1px solid var(--a-line);
      border-left: 4px solid var(--a-warn);
      border-radius: var(--radius);
      background: var(--a-surface);
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
      color: var(--a-ink);
      font-size: 0.9rem;
      pointer-events: none;
      transition:
        opacity var(--dur-base) var(--ease-out),
        transform var(--dur-base) var(--ease-out);
    }
    .slow.inline {
      position: static;
      margin: 0;
      max-width: none;
      box-shadow: none;
    }
    @starting-style {
      .slow {
        opacity: 0;
        transform: translateY(8px);
      }
    }
    .slow-leave {
      animation: slow-out var(--dur-base) var(--ease-out) forwards;
    }
    @keyframes slow-out {
      to {
        opacity: 0;
        transform: translateY(8px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .slow {
        transition: none;
      }
      .slow-leave {
        animation: none;
      }
    }
  `,
})
export class SlowCommandNotice {
  private readonly watch = inject(SlowCommandWatch);

  readonly module = input.required<CommandModule>();
  /** No fluxo da página, em vez de flutuando. */
  readonly inline = input(false);

  protected readonly slow = computed(() => this.watch.isSlow(this.module()));
}
