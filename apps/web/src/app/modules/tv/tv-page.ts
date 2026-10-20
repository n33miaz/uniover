import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ControlPage } from './pages/control.page';
import { TV_PANEL_PARAM, TvPanelName, panelFromParam } from './data/tv-panels';
import { SessionState } from '../../core/session/session-state';
import { TvStore } from './data/tv-store';
import { AppsPanel } from './panels/apps-panel';
import { KeyboardPanel } from './panels/keyboard-panel';
import { PowerSheet } from './ui/power-sheet';
import { StatusIndicator } from './ui/status-indicator';
import { TvIcon } from './ui/tv-icon';
import { TvPanel } from './ui/tv-panel';

/**
 * Tela única do módulo da TV: cabeçalho (voltar ao Início, nome com o ponto de estado e energia), o controle e, por
 * cima dele, os painéis flutuantes de Apps e Teclado. O estado da TV (`TvStore`) é um só; ele só fala com o
 * servidor enquanto esta tela existe (ao sair, o fluxo e o "aquecer" param). Fica na raiz, e não nos `providers`
 * do componente, porque o recurso de providers de componente puxaria código do Angular para o pacote inicial.
 *
 * Os endereços antigos `/tv/apps` e `/tv/teclado` redirecionam para `/tv?painel=...`: ao chegar com esse
 * parâmetro a tela abre o painel e tira o parâmetro do endereço (recarregar não reabre).
 */
@Component({
  selector: 'app-tv-page',
  imports: [
    RouterLink,
    ControlPage,
    StatusIndicator,
    TvIcon,
    PowerSheet,
    TvPanel,
    AppsPanel,
    KeyboardPanel,
  ],
  templateUrl: './tv-page.html',
  styleUrl: './tv-page.css',
})
export class TvPage {
  protected readonly store = inject(TvStore);
  /** Convidado vê só o controle: sem o retorno ao Início (as outras telas nem existem para ele). */
  protected readonly isGuest = inject(SessionState).isGuest;

  protected readonly powerOpen = signal(false);
  /** Painel flutuante aberto no momento (um por vez). */
  protected readonly panel = signal<TvPanelName | null>(null);
  /** O botão que abriu o painel (vazio quando o painel abriu pelo endereço). */
  protected readonly panelOpener = signal<HTMLElement | null>(null);

  protected readonly appsTitle = $localize`:@@tv.apps.title:Apps da TV`;
  protected readonly keyboardTitle = $localize`:@@tv.keyboard.title:Teclado`;

  /** O aviso flutuante some enquanto há um painel aberto: o painel mostra o aviso dentro dele. */
  protected readonly showToast = computed(() => this.panel() === null && !this.powerOpen());

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    // O store só abre o fluxo e começa a "aquecer" quando a tela nasce e para quando ela é destruída.
    this.store.start();
    inject(DestroyRef).onDestroy(() => this.store.stop());

    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const requested = panelFromParam(params.get(TV_PANEL_PARAM));
      if (requested === null) return;
      this.panelOpener.set(null);
      this.panel.set(requested);
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { [TV_PANEL_PARAM]: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
  }

  protected open(panel: TvPanelName, opener: HTMLElement): void {
    this.panelOpener.set(opener);
    this.panel.set(panel);
  }

  protected closePanel(): void {
    this.panel.set(null);
  }
}
