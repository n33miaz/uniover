import { Component, inject } from '@angular/core';
import { InstallHintRow } from '../../core/pwa/install-hint-row';
import { AppearanceService, ThemePreference } from '../../core/session/appearance.service';

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
  imports: [InstallHintRow],
  templateUrl: './appearance.page.html',
  styleUrl: './appearance.page.css',
})
export class AppearancePage {
  private readonly appearance = inject(AppearanceService);

  protected readonly themePreference = this.appearance.preference;

  protected readonly themeChoices: readonly ThemeChoice[] = [
    { value: 'auto', label: $localize`:@@settings.theme.auto:Automático` },
    { value: 'light', label: $localize`:@@settings.theme.light:Claro` },
    { value: 'dark', label: $localize`:@@settings.theme.dark:Escuro` },
  ];

  protected chooseTheme(value: ThemePreference): void {
    this.appearance.set(value);
  }
}
