import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  computed,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { SlowCommandNotice } from '../../core/connectivity/slow-command-notice';
import { Skeleton } from '../../shared/ui/skeleton/skeleton';
import { PcArmed } from './data/pc-armed';
import { PcDirect } from './data/pc-direct';
import { PcStore } from './data/pc-store';
import { PcSwitcherBar } from './ui/switcher-bar';
import { watchAvailableHeight, type ViewportWatch } from './input/viewport-fit';

/**
 * Casca do módulo: o estado do PC e, embaixo, a aba aberta. Conectado, o estado é um ponto de 10 px no canto de cima
 * (cheio e verde); nos outros casos é a pílula com a palavra. Sem PC conectado nenhuma aba mostraria um controle que não
 * leva a lugar nenhum, então no lugar dela ficam uma frase curta e o botão. Enquanto a primeira leitura não chega,
 * o esqueleto tem a forma da tela do mouse (a tela não pula quando o estado chega).
 *
 * A altura é medida (ver `watchAvailableHeight`): a tela do mouse ocupa exatamente o que sobra entre o cabeçalho e a barra
 * de abas, com ou sem o aviso de versão nova, e as outras abas têm no mínimo essa altura e crescem com o conteúdo.
 */
@Component({
  selector: 'app-pc-page',
  host: { 'data-screen-ready': 'pc' },
  imports: [RouterLink, RouterOutlet, Skeleton, PcSwitcherBar, SlowCommandNotice],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      #screen
      class="pc"
      [class.fill]="fill() || store.phase() === 'loading'"
      [attr.data-phase]="store.phase()"
      [style.--pc-h]="height() === null ? null : height() + 'px'"
      [style.--pc-tabs]="tabsHeight() === null ? null : tabsHeight() + 'px'"
    >
      <p
        class="status"
        role="status"
        [attr.data-phase]="store.phase()"
        [attr.data-transport]="store.phase() === 'ready' ? direct.mode() : null"
        [attr.title]="statusHint()"
      >
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
            <h2 i18n="@@pc.unavailable.title">Nenhum PC Seu Conectado</h2>
            <p i18n="@@pc.unavailable.text">Instale o conector e ligue o controle do PC.</p>
            <a routerLink="/conectar" class="ui-btn" i18n="@@pc.unavailable.install">
              Instalar o Conector
            </a>
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
            <p i18n="@@pc.offline.text">Ligue o PC e espere ele conectar.</p>
            <button type="button" class="ui-btn" (click)="retry()" i18n="@@pc.retry">
              Tentar de Novo
            </button>
          </div>
        }
        @default {
          <router-outlet (activate)="onActivate($event)" (deactivate)="onDeactivate()" />
        }
      }

      <!-- Com o Alt segurado a barra do "Trocar janela" acompanha qualquer aba: ninguém fica sem como soltá-lo. -->
      <app-pc-switcher-bar class="switcher" [class.float]="fill()" />

      @if (!pageToast() && store.notice(); as notice) {
        <div class="notice ui-notice bad" role="alert" [class.float]="fill()">
          <span>{{ notice.message }}</span>
          @if (canRetryDeviceApproval(notice.kind)) {
            <button
              type="button"
              class="ui-btn secondary"
              (click)="retryDeviceApproval()"
              i18n="@@pc.approval.retry"
            >
              Tentar de Novo
            </button>
          }
        </div>
      }
      <app-slow-command-notice [module]="'pc'" />
    </section>
  `,
  styleUrl: './pc-page.css',
})
export class PcPage {
  protected readonly store = inject(PcStore);
  protected readonly direct = inject(PcDirect);
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private watch: ViewportWatch | null = null;
  private readonly screen = viewChild.required<ElementRef<HTMLElement>>('screen');
  /** A aba aberta pede a altura toda (a do mouse); as outras crescem com o conteúdo. */
  protected readonly fill = signal(false);
  /** A aba aberta mostra agora um aviso próprio no mesmo lugar (o do mouse): um aviso por vez, o dela é o mais novo. */
  private readonly pageToastShown = signal<(() => boolean) | null>(null);
  protected readonly pageToast = computed(() => this.pageToastShown()?.() ?? false);
  /** A altura que sobra entre o cabeçalho e a barra de abas, em pixels; `null` até a primeira medida. */
  protected readonly height = signal<number | null>(null);
  /** A altura medida da barra de abas (a folga da barra do "Trocar janela" acima dela); `null` até a primeira medida. */
  protected readonly tabsHeight = signal<number | null>(null);

  protected readonly statusLabel = computed(() => {
    switch (this.store.phase()) {
      case 'ready':
        return this.direct.mode() === 'direct'
          ? $localize`:@@pc.status.direct:Conectado, direto`
          : $localize`:@@pc.status.ready:Conectado`;
      case 'offline':
        return $localize`:@@pc.status.offline:Sem Conexão`;
      case 'unavailable':
        return $localize`:@@pc.status.unavailable:Sem PC`;
      default:
        return $localize`:@@pc.status.loading:Conectando`;
    }
  });

  /** Pela dica do ponto: o caminho que os comandos fazem agora (o leitor de tela já lê a palavra do estado). */
  protected readonly statusHint = computed(() => {
    if (this.store.phase() !== 'ready') return null;
    return this.direct.mode() === 'direct'
      ? $localize`:@@pc.status.direct-hint:Conexão direta com o PC`
      : $localize`:@@pc.status.cloud-hint:Pela nuvem`;
  });

  constructor() {
    const destroy = inject(DestroyRef);
    this.store.watch(destroy);
    // As teclas armadas valem só dentro do módulo: sair dele as solta (Win armado não pode esperar, invisível, a próxima tela).
    const armed = inject(PcArmed);
    destroy.onDestroy(() => armed.clear());
    afterNextRender(() => {
      const watch = watchAvailableHeight(this.doc, this.screen().nativeElement, (value, tabs) => {
        this.height.set(value);
        this.tabsHeight.set(tabs);
      });
      this.watch = watch;
      destroy.onDestroy(() => watch.stop());
    });
    // A tela do mouse puxa um pouco do respiro da página (margem negativa): ao entrar ou sair dela a conta se refaz.
    effect(() => {
      this.fill();
      untracked(() => afterNextRender(() => this.watch?.remeasure(), { injector: this.injector }));
    });
  }

  protected onActivate(page: object): void {
    this.fill.set('fillsScreen' in page && page.fillsScreen === true);
    const shown = 'toastShown' in page ? page.toastShown : null;
    this.pageToastShown.set(typeof shown === 'function' ? () => Boolean(shown()) : null);
  }

  protected onDeactivate(): void {
    this.fill.set(false);
    this.pageToastShown.set(null);
  }

  protected retry(): void {
    void this.store.refresh();
  }

  protected canRetryDeviceApproval(kind: string): boolean {
    // Recusado não tem botão: o computador guarda o Não por uma hora, e pedir de novo antes disso não muda nada.
    return kind === 'device-pending' || kind === 'device-unknown';
  }

  protected retryDeviceApproval(): void {
    void this.store.requestApproval();
  }
}
