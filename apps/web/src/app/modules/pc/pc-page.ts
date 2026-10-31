import { DestroyRef, ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Skeleton } from '../../shared/ui/skeleton/skeleton';
import { PcStore } from './data/pc-store';

/**
 * Casca do módulo: o estado do PC (verde quando conectado) e, embaixo, a aba aberta. Sem PC conectado nenhuma aba
 * mostraria um controle que não leva a lugar nenhum, então no lugar dela fica uma frase curta e a ação possível.
 * Enquanto a primeira leitura não chega, o esqueleto tem a forma do touchpad (a tela não pula quando o estado chega).
 */
@Component({
  selector: 'app-pc-page',
  imports: [RouterOutlet, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="pc" [attr.data-phase]="store.phase()">
      <p class="status" role="status" [attr.data-phase]="store.phase()">
        <span class="dot" aria-hidden="true"></span>
        <span class="label">{{ statusLabel() }}</span>
      </p>

      @switch (store.phase()) {
        @case ('loading') {
          <div class="loading" aria-busy="true">
            <span appSkeleton class="pad-skeleton"></span>
            <span appSkeleton class="row-skeleton"></span>
          </div>
        }
        @case ('unavailable') {
          <div class="empty">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="art">
              <rect x="3" y="4" width="18" height="12" rx="2" />
              <path [attr.d]="'M8 20h8M12 16v4'" />
            </svg>
            <h2 i18n="@@pc.unavailable.title">Nenhum PC Ligado</h2>
            <p i18n="@@pc.unavailable.text">No PC, rode este comando e reinicie o agente:</p>
            <code>{{ enableCommand }}</code>
          </div>
        }
        @case ('offline') {
          <div class="empty">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="art asleep">
              <rect x="3" y="4" width="18" height="12" rx="2" />
              <path [attr.d]="'M8 20h8M12 16v4'" />
              <path [attr.d]="'M7.5 9.5h3l-3 3h3'" />
            </svg>
            <h2 i18n="@@pc.offline.title">PC Desconectado</h2>
            <p i18n="@@pc.offline.text">Ligue o PC e espere o agente conectar.</p>
            <button type="button" class="ui-btn" (click)="retry()" i18n="@@pc.retry">
              Tentar de Novo
            </button>
          </div>
        }
        @default {
          <router-outlet />
        }
      }

      @if (store.notice(); as notice) {
        <p class="notice" role="alert">{{ notice.message }}</p>
      }
    </section>
  `,
  styleUrl: './pc-page.css',
})
export class PcPage {
  protected readonly store = inject(PcStore);
  /** O comando é do agente, não se traduz. */
  protected readonly enableCommand = 'uniover-agent pc-control on';

  protected readonly statusLabel = computed(() => {
    switch (this.store.phase()) {
      case 'ready':
        return $localize`:@@pc.status.ready:Conectado`;
      case 'offline':
        return $localize`:@@pc.status.offline:Sem Conexão`;
      case 'unavailable':
        return $localize`:@@pc.status.unavailable:Sem PC`;
      default:
        return $localize`:@@pc.status.loading:Conectando`;
    }
  });

  constructor() {
    this.store.watch(inject(DestroyRef));
  }

  protected retry(): void {
    void this.store.refresh();
  }
}
