import {
  Component,
  DestroyRef,
  ViewContainerRef,
  afterNextRender,
  inject,
  viewChild,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectivityBanner } from './core/connectivity/connectivity-banner';
import { AppearanceService } from './core/session/appearance.service';
import { SessionNotice } from './core/session/session-notice';
import { UpdateSkeleton } from './core/pwa/update-skeleton';
import { ThemeService } from './core/theme/theme.service';

@Component({
  imports: [RouterOutlet, UpdateSkeleton, ConnectivityBanner, SessionNotice],
  selector: 'app-root',
  template: `
    <ng-container #updateBanner></ng-container>
    <app-connectivity-banner />
    <app-session-notice />
    <router-outlet />
    <app-update-skeleton />
  `,
})
export class App {
  // Instanciar aqui garante que o tema segue o sistema desde o primeiro quadro.
  protected readonly theme = inject(ThemeService);
  // Depois do ThemeService: a escolha fixa de tema do aparelho vale desde o primeiro quadro.
  private readonly appearance = inject(AppearanceService);
  private readonly updateBanner = viewChild('updateBanner', { read: ViewContainerRef });
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.appearance.restore();
    // O aviso carrega depois da primeira pintura; quem decide mostrá-lo é o PwaUpdateService (já iniciado), então uma
    // atualização detectada antes de o aviso existir aparece assim que ele nasce.
    let destroyed = false;
    this.destroyRef.onDestroy(() => (destroyed = true));
    afterNextRender(() => {
      void import('./core/pwa/update-banner')
        .then(({ UpdateBanner }) => {
          if (!destroyed) this.updateBanner()?.createComponent(UpdateBanner);
        })
        // Sem o pedaço (sem rede ou cache antigo) o app segue sem o aviso, em vez de um erro de carregamento.
        .catch(() => undefined);
    });
  }
}
