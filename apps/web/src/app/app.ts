import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme/theme.service';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  template: '<router-outlet />',
})
export class App {
  // Instanciar aqui garante que o tema segue o sistema desde o primeiro quadro.
  protected readonly theme = inject(ThemeService);
}
