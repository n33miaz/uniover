import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectivityBanner } from './core/connectivity/connectivity-banner';
import { AppearanceService } from './core/session/appearance.service';
import { SessionNotice } from './core/session/session-notice';
import { UpdateBanner } from './core/pwa/update-banner';
import { ThemeService } from './core/theme/theme.service';

@Component({
  imports: [RouterOutlet, UpdateBanner, ConnectivityBanner, SessionNotice],
  selector: 'app-root',
  template: `
    <app-update-banner />
    <app-connectivity-banner />
    <app-session-notice />
    <router-outlet />
  `,
})
export class App {
  // Instanciar aqui garante que o tema segue o sistema desde o primeiro quadro.
  protected readonly theme = inject(ThemeService);
  // Depois do ThemeService: a escolha fixa de tema do aparelho vale desde o primeiro quadro.
  private readonly appearance = inject(AppearanceService);

  constructor() {
    this.appearance.restore();
  }
}
