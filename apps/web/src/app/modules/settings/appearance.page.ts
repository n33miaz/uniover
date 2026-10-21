import { Component, computed, inject } from '@angular/core';
import { ModulePrefs } from '../../core/modules/module-prefs';
import { ModuleDefinition, ModuleRegistry } from '../../core/modules/module-registry';
import { InstallHintRow } from '../../core/pwa/install-hint-row';
import { AppearanceService, ThemePreference } from '../../core/session/appearance.service';
import { SessionState } from '../../core/session/session-state';
import { SettingsGlyph, SettingsGlyphName, moduleGlyph } from './settings-glyph';

interface ThemeChoice {
  readonly value: ThemePreference;
  readonly label: string;
}

/**
 * Aparência: o tema (claro, escuro ou o do aparelho), o atalho na tela de início e, só para quem tem a Início, quais
 * módulos aparecem nela. Tudo vale só neste aparelho. Serve a todos os papéis; o convidado não tem Início, então não vê
 * a lista de módulos (ela não mudaria nada para ele).
 */
@Component({
  selector: 'app-appearance-page',
  imports: [SettingsGlyph, InstallHintRow],
  templateUrl: './appearance.page.html',
  styleUrl: './appearance.page.css',
})
export class AppearancePage {
  private readonly prefs = inject(ModulePrefs);
  private readonly appearance = inject(AppearanceService);
  private readonly session = inject(SessionState);
  protected readonly registry = inject(ModuleRegistry);

  protected readonly themePreference = this.appearance.preference;
  /** Só quem tem a Início escolhe o que aparece nela. */
  protected readonly hasHome = computed(() => !this.session.isGuest());

  protected readonly themeChoices: readonly ThemeChoice[] = [
    { value: 'auto', label: $localize`:@@settings.theme.auto:Automático` },
    { value: 'light', label: $localize`:@@settings.theme.light:Claro` },
    { value: 'dark', label: $localize`:@@settings.theme.dark:Escuro` },
  ];

  protected glyphFor(module: ModuleDefinition): SettingsGlyphName {
    return moduleGlyph(module.icon);
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
}
