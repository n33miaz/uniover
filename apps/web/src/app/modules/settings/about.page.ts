import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthApi } from '../../core/auth/auth-api';
import { SessionState } from '../../core/session/session-state';
import { version as appVersion } from '../../../../package.json';
import { SettingsGlyph } from './settings-glyph';

/**
 * Sobre: a versão do app (lida do `package.json` na compilação) e a da API publicada, e o caminho para os Créditos. Serve
 * a todos os papéis; a tela de Créditos, porém, é do administrador,
 * então a linha dela só aparece para ele.
 */
@Component({
  selector: 'app-about-page',
  imports: [RouterLink, SettingsGlyph],
  templateUrl: './about.page.html',
  styleUrl: './about.page.css',
})
export class AboutPage {
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);

  protected readonly apiVersion = signal<string | null | 'loading'>('loading');

  /** Versão do app, lida do `package.json` na compilação. */
  protected readonly appVersion: string | null = appVersion || null;

  protected readonly showCredits = computed(() => this.session.role() === 'owner');

  constructor() {
    void this.loadApiVersion();
  }

  private async loadApiVersion(): Promise<void> {
    try {
      this.apiVersion.set((await this.api.deploymentVersion()).version || null);
    } catch {
      this.apiVersion.set(null);
    }
  }
}
