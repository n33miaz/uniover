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

  /** A barra "Aplicar na TV" existe nas telas que editam a configuração, e só com a TV ao alcance. */
  protected readonly showApply = computed(() => this.store.canUse() && this.active() !== 'install');
  protected readonly applying = computed(() => this.store.busy() === 'apply');

  constructor() {
    this.store.start();
    inject(DestroyRef).onDestroy(() => this.store.stop());
  }

  protected select(tab: LivreTab): void {
    if (tab === this.active()) return;
    this.active.set(tab);
    // O aviso era do pedido da tela anterior.
    this.store.clearNotice();
  }

  /** Setas, Início e Fim passam de aba em aba (só a aba marcada entra na ordem do Tab, como pede o padrão de abas). */
  protected onTabKey(event: KeyboardEvent): void {
    const count = this.tabs.length;
    const index = this.tabs.findIndex((tab) => tab.id === this.active());
    let target = -1;
    if (event.key === 'ArrowRight') target = (index + 1) % count;
    else if (event.key === 'ArrowLeft') target = (index - 1 + count) % count;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = count - 1;
    if (target < 0) return;
    event.preventDefault();
    const id = this.tabs[target].id;
    this.select(id);
    this.host.nativeElement.querySelector<HTMLElement>(`#livre-tab-${id}`)?.focus();
  }
}
