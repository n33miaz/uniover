import { Component, afterNextRender, inject, signal } from '@angular/core';
import { InstallHintRow } from '../../core/pwa/install-hint-row';
import { AppearanceService, ThemePreference } from '../../core/session/appearance.service';
import { SettingsPageSkeleton } from './settings-page-skeleton';

interface ThemeChoice {
  readonly value: ThemePreference;
  readonly label: string;
}

/**
 * Aparência: o tema (claro, escuro ou o do aparelho) e o atalho de instalação. A escolha dos módulos fica em
 * Personalizar, junto da ordem da Início, para não oferecer a mesma decisão em dois lugares. Tudo vale só neste
 * aparelho e serve a todos os papéis.
 */
@Component({
  selector: 'app-appearance-page',
  imports: [InstallHintRow, SettingsPageSkeleton],
  templateUrl: './appearance.page.html',
  styleUrl: './appearance.page.css',
})
export class AppearancePage {
  private readonly appearance = inject(AppearanceService);

  protected readonly themePreference = this.appearance.preference;
  protected readonly loading = signal(true);

  protected readonly themeChoices: readonly ThemeChoice[] = [
    { value: 'light', label: $localize`:@@settings.theme.light:Claro` },
    { value: 'dark', label: $localize`:@@settings.theme.dark:Escuro` },
    { value: 'auto', label: $localize`:@@settings.theme.auto:Automático` },
  ];

  constructor() {
    // A forma local ocupa o primeiro quadro da rota preguiçosa; a preferência já está no aparelho no quadro seguinte.
    afterNextRender(() => this.loading.set(false));
  }

  protected chooseTheme(value: ThemePreference): void {
    this.appearance.set(value);
  }
}
