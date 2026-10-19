import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectivityBanner } from './core/connectivity/connectivity-banner';
import { UpdateBanner } from './core/pwa/update-banner';
import { ThemeService } from './core/theme/theme.service';

@Component({
  imports: [RouterOutlet, UpdateBanner, ConnectivityBanner],
  selector: 'app-root',
  template: `
    <app-update-banner />
    <app-connectivity-banner />
    <router-outlet />
  `,
})
export class App {
  // Instanciar aqui garante que o tema segue o sistema desde o primeiro quadro.
  protected readonly theme = inject(ThemeService);
}
