import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { ModulePrefs } from '../../core/modules/module-prefs';
import { ModuleDefinition, ModuleRegistry } from '../../core/modules/module-registry';
import { AppearanceService, ThemePreference } from '../../core/session/appearance.service';
import { SessionState } from '../../core/session/session-state';
import { version as appVersion } from '../../../../package.json';
import { GuestsSection } from './guests-section';
import { SecuritySection } from './security-section';

interface ThemeChoice {
  readonly value: ThemePreference;
  readonly label: string;
}

/**
 * Ajustes: conta e sessão, módulos ligados/desligados, aparência, segurança (passkeys) e sobre. Tela simples,
 * em lista; sem abas. Só o dono chega aqui (o convidado não tem Ajustes). Fora do básico (de propósito): PIN local, pessoas da casa, exportar configuração.
 */
@Component({
  selector: 'app-settings-page',
  imports: [SecuritySection, GuestsSection, RouterLink],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
})
export class SettingsPage {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);
  private readonly prefs = inject(ModulePrefs);
  private readonly appearance = inject(AppearanceService);
  protected readonly registry = inject(ModuleRegistry);

  protected readonly user = this.session.user;
  protected readonly status = this.session.status;
  protected readonly themePreference = this.appearance.preference;
  protected readonly loggingOut = signal(false);
  protected readonly logoutUnconfirmed = signal(false);
  protected readonly apiVersion = signal<string | null | 'loading'>('loading');

  /** Versão do app, lida do `package.json` na compilação. */
  protected readonly appVersion: string | null = appVersion || null;

  protected readonly themeChoices: readonly ThemeChoice[] = [
    { value: 'auto', label: $localize`:@@settings.theme.auto:Automático (segue o sistema)` },
    { value: 'light', label: $localize`:@@settings.theme.light:Claro` },
    { value: 'dark', label: $localize`:@@settings.theme.dark:Escuro` },
  ];

  protected readonly sessionText = computed(() => {
    switch (this.status()) {
      case 'authenticated':
        return $localize`:@@settings.session.active:Sessão ativa.`;
      case 'pending':
        return $localize`:@@settings.session.pending:Sessão a confirmar: sem conexão com o servidor. Nada foi apagado e o app confirma sozinho quando a conexão voltar.`;
      case 'anonymous':
        return $localize`:@@settings.session.anonymous:Sem sessão.`;
      default:
        return $localize`:@@settings.session.unknown:Verificando a sessão…`;
    }
  });

  constructor() {
    void this.loadApiVersion();
  }

  protected enabled(module: ModuleDefinition): boolean {
    return this.prefs.widgets().find((pref) => pref.id === module.id)?.enabled ?? true;
  }

  protected statusLabel(module: ModuleDefinition): string {
    return module.status === 'available'
      ? $localize`:@@settings.module.available:Disponível`
      : $localize`:@@settings.module.soon:Em breve`;
  }

  protected toggleModule(module: ModuleDefinition, event: Event): void {
    this.prefs.setEnabled(module.id, (event.target as HTMLInputElement).checked);
  }

  protected chooseTheme(value: ThemePreference): void {
    this.appearance.set(value);
  }

  protected async logout(): Promise<void> {
    this.loggingOut.set(true);
    try {
      this.logoutUnconfirmed.set(!(await this.auth.logout()));
    } finally {
      this.loggingOut.set(false);
    }
  }

  private async loadApiVersion(): Promise<void> {
    try {
      this.apiVersion.set((await this.api.info()).version || null);
    } catch {
      this.apiVersion.set(null);
    }
  }
}
