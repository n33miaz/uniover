import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { AuthApi } from '../../core/auth/auth-api';
import { canUseModule } from '../../core/auth/guest-home';
import { SessionState } from '../../core/session/session-state';
import { version as appVersion } from '../../../../package.json';
import { SettingsGlyph } from './settings-glyph';

/**
 * Sobre: a versão do app (lida do `package.json` na compilação) e a da API publicada, e o caminho para os Créditos, que abrem como folha por cima desta tela (a rota filha). Serve
 * a todos os papéis. Créditos é conteúdo do Treino, então aparece para qualquer pessoa que tenha esse módulo.
 */
@Component({
  selector: 'app-about-page',
  imports: [RouterLink, RouterOutlet, SettingsGlyph],
  templateUrl: './about.page.html',
  styleUrl: './about.page.css',
})
export class AboutPage {
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);

  protected readonly apiVersion = signal<string | null | 'loading'>('loading');

  /** Versão do app, lida do `package.json` na compilação. */
  protected readonly appVersion: string | null = appVersion || null;

  protected readonly showCredits = computed(() =>
    canUseModule(this.session.role(), this.session.knownPermissions(), 'training'),
  );

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
