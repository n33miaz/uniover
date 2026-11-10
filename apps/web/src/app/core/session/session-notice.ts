import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { AUTH_CONFIG } from '../auth/auth.service';
import { ResumeGrace } from '../connectivity/resume-grace';
import { SessionState } from './session-state';

/**
 * Aviso "sessão a confirmar": aparece enquanto o app não conseguiu confirmar a sessão (sem rede, servidor
 * dormindo). A casca segue disponível e nada local é apagado. Fica na raiz do app; a tela de Ajustes mostra
 * o mesmo estado. A faixa abre e fecha empurrando a tela (ver `ui-collapse` em styles.css), sem salto.
 *
 * Logo ao voltar ao app a renovação da sessão pode sair numa conexão já derrubada e falhar sem que nada esteja errado: se a
 * sessão ficou pendente na carência da volta (`ResumeGrace`), a faixa espera a carência e a repetição rápida da renovação
 * (`lostResponseRetryMs`) antes de aparecer; se a renovação deu certo nesse meio tempo, ela nunca chega a aparecer.
 */
@Component({
  selector: 'app-session-notice',
  template: `
    <div role="status">
      @if (visible()) {
        <div class="ui-collapse" [animate.leave]="'leaving'">
          <div class="ui-collapse-inner">
            <p class="notice" i18n="@@session.pending">
              Sessão a confirmar. Assim que houver conexão o app confirma sozinho; nada foi apagado.
            </p>
          </div>
        </div>
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
  private readonly grace = inject(ResumeGrace);
  private readonly holdMs = inject(AUTH_CONFIG).lostResponseRetryMs + 1_500;
  /** A sessão ficou pendente na volta ao app: a faixa espera a repetição rápida antes de aparecer. */
  private readonly held = signal(false);

  protected readonly visible = computed(
    () => this.session.status() === 'pending' && !this.grace.active() && !this.held(),
  );

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    inject(DestroyRef).onDestroy(() => clearTimeout(timer));
    effect(() => {
      const pending = this.session.status() === 'pending';
      untracked(() => {
        clearTimeout(timer);
        if (pending && this.grace.active()) {
          this.held.set(true);
          timer = setTimeout(() => this.held.set(false), this.holdMs);
        } else {
          this.held.set(false);
        }
      });
    });
  }
}
