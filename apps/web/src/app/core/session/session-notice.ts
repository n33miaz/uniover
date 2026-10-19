import { Component, inject } from '@angular/core';
import { SessionState } from './session-state';

/**
 * Aviso "sessão a confirmar": aparece enquanto o app não conseguiu confirmar a sessão (sem rede, servidor
 * dormindo). A casca segue disponível e nada local é apagado. Fica na raiz do app; a tela de Ajustes mostra
 * o mesmo estado.
 */
@Component({
  selector: 'app-session-notice',
  template: `
    <div role="status">
      @if (session.status() === 'pending') {
        <p class="notice" i18n="@@session.pending">
          Sessão a confirmar. Assim que houver conexão o app confirma sozinho; nada foi apagado.
        </p>
      }
    </div>
  `,
  styles: `
    .notice {
      margin: 0;
      padding: 10px var(--gutter);
      font-size: 0.9rem;
      border-bottom: 1px solid var(--a-line);
      border-left: 4px solid var(--a-warn);
      background: var(--a-elev);
      color: var(--a-ink);
    }
  `,
})
export class SessionNotice {
  protected readonly session = inject(SessionState);
}
