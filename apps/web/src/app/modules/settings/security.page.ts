import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionState } from '../../core/session/session-state';
import { SecuritySection } from './security-section';
import { SettingsGlyph } from './settings-glyph';
import { SETTINGS_TITLES } from './settings-titles';
import { SessionsSection } from './sessions-section';

/**
 * Segurança pessoal. O dono vê as passkeys e as Sessões de Acesso da conta; o convidado vê só as próprias sessões (as
 * passkeys são rota de dono, então a tela nem as menciona para ele).
 */
@Component({
  selector: 'app-security-page',
  imports: [RouterLink, SecuritySection, SessionsSection, SettingsGlyph],
  template: `
    <app-sessions-section class="ui-rise" />
    @if (isOwner()) {
      <app-security-section class="ui-rise" />
      <ul class="ui-group siri ui-rise">
        <li>
          <a class="ui-row" routerLink="/ajustes/seguranca/siri">
            <span class="ui-tile"><app-settings-glyph name="tv" /></span>
            <span class="ui-row-text">
              <span class="ui-row-title">{{ siriTitle }}</span>
            </span>
            <app-settings-glyph class="chev" name="chevron" />
          </a>
        </li>
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
      max-width: 40rem;
      margin-inline: auto;
    }

    .siri {
      margin-block: var(--space-4) 0;
      padding: 0;
      list-style: none;
    }

    .ui-row-title {
      font-weight: 650;
    }

    .chev {
      --glyph-size: 20px;
      margin-left: auto;
      color: var(--a-ink3);
    }
  `,
})
export class SecurityPage {
  private readonly session = inject(SessionState);

  protected readonly siriTitle = SETTINGS_TITLES.siri;
  protected readonly isOwner = computed(() => this.session.role() === 'owner');
}
