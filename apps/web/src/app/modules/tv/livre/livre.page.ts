import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';
import { TvLivreStore } from './data/livre-store';
import { LivreBackgroundTab } from './ui/livre-background-tab';
import { AdbPermissionNotice } from '../ui/adb-permission';
import { LivreHomeTab } from './ui/livre-home-tab';
import { LivreInstallTab } from './ui/livre-install-tab';
import { LivreSleepTab } from './ui/livre-sleep-tab';

type LivreTab = 'home' | 'background' | 'sleep' | 'install';

/**
 * Tela do TV Livre (`/tv/livre`, só do dono): o launcher próprio da TV. O topo (seta de volta ao controle e o título) é o
 * do shell, pelos dados da rota. Aqui ficam as quatro telas em abas, o aviso do último pedido e, nas telas que mexem na
 * configuração (Home da TV, Fundo, Dormir), a barra fixa com "Aplicar na TV", que é a única coisa que escreve na TV.
 * Enquanto o estado não chega, um esqueleto com a forma da tela; se a primeira leitura falha, o aviso com "Tentar de Novo".
 */
@Component({
  selector: 'app-livre-page',
  imports: [
    NgTemplateOutlet,
    AdbPermissionNotice,
    LoadingFrame,
    Skeleton,
    LivreHomeTab,
    LivreBackgroundTab,
    LivreSleepTab,
    LivreInstallTab,
  ],
  templateUrl: './livre.page.html',
  styleUrl: './livre.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivrePage {
  protected readonly store = inject(TvLivreStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly tabs: readonly { readonly id: LivreTab; readonly label: string }[] = [
    { id: 'home', label: $localize`:@@tv-livre.tab.home:Home da TV` },
    { id: 'background', label: $localize`:@@tv-livre.tab.background:Fundo` },
    { id: 'sleep', label: $localize`:@@tv-livre.tab.sleep:Dormir` },
    { id: 'install', label: $localize`:@@tv-livre.tab.install:Instalação` },
  ];
  protected readonly active = signal<LivreTab>('home');
  protected readonly needsInstall = computed(() => this.store.view()?.installed === false);
  protected readonly visibleTabs = computed(() =>
    this.needsInstall() ? this.tabs.filter((tab) => tab.id === 'install') : this.tabs,
  );
  protected readonly currentTab = computed<LivreTab>(() =>
    this.needsInstall() ? 'install' : this.active(),
  );

  /**
   * A barra "Aplicar na TV" existe nas telas que editam a configuração, com a TV ao alcance e só quando há o que levar a ela:
   * uma mudança ainda não enviada, uma configuração guardada que a TV não aplicou (a barra fica para tentar de novo) ou o
   * pedido de aplicar em andamento (guardar já deixa o rascunho igual ao guardado, e a barra não pode sumir no meio).
   * O resultado do pedido fica na barra até a próxima mudança, para a pessoa vê-lo onde tocou.
   */
  protected readonly showApply = computed(
    () =>
      this.store.canUse() &&
      this.currentTab() !== 'install' &&
      (this.store.pending() || this.applying() || this.store.notice() !== null),
  );
  protected readonly applying = computed(() => this.store.busy() === 'apply');
  /** "Descartar" só existe para o que foi mexido: a configuração guardada que falhou ao aplicar não tem o que desfazer. */
  protected readonly canDiscard = computed(() => this.store.dirty() && !this.applying());

  constructor() {
    this.store.start();
    inject(DestroyRef).onDestroy(() => this.store.stop());
  }

  protected select(tab: LivreTab): void {
    if (tab === this.currentTab()) return;
    this.active.set(tab);
    // O aviso era do pedido da tela anterior.
    this.store.clearNotice();
  }

  /** Setas, Início e Fim passam de aba em aba (só a aba marcada entra na ordem do Tab, como pede o padrão de abas). */
  protected onTabKey(event: KeyboardEvent): void {
    const tabs = this.visibleTabs();
    const count = tabs.length;
    const index = tabs.findIndex((tab) => tab.id === this.currentTab());
    let target = -1;
    if (event.key === 'ArrowRight') target = (index + 1) % count;
    else if (event.key === 'ArrowLeft') target = (index - 1 + count) % count;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = count - 1;
    if (target < 0) return;
    event.preventDefault();
    const id = tabs[target].id;
    this.select(id);
    this.host.nativeElement.querySelector<HTMLElement>(`#livre-tab-${id}`)?.focus();
  }
}
