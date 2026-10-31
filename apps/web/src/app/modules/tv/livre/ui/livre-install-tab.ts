import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { clockText } from '../../data/tv-types';
import { TvLivreStore } from '../data/livre-store';

/**
 * Tela "Instalação": o estado do TV Livre na TV e os passos na ordem segura: Instalar, olhar a Home na TV (Aplicar na TV, em
 * outra tela) e só então Definir Como Padrão, com a opção, desligada, de desativar o launcher de fábrica. "Voltar ao
 * Original" é a saída e fica sempre à vista quando a TV é compatível, com uma confirmação curta antes de agir.
 */
@Component({
  selector: 'app-livre-install-tab',
  templateUrl: './livre-install-tab.html',
  styleUrl: './livre-install-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivreInstallTab {
  protected readonly store = inject(TvLivreStore);

  /** Desativar o launcher de fábrica junto com "Definir Como Padrão": começa desligado, porque é o passo mais difícil de desfazer. */
  protected readonly disableFactory = signal(false);
  protected readonly confirmingRestore = signal(false);
  private readonly injector = inject(Injector);
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly restoreButton = viewChild<ElementRef<HTMLButtonElement>>('restoreButton');

  protected readonly idle = computed(() => this.store.canUse() && this.store.busy() === null);
  protected readonly installed = computed(() => this.store.view()?.installed === true);
  protected readonly isHome = computed(() => this.store.view()?.isHome === true);
  protected readonly version = computed(() => this.store.view()?.version ?? null);
  protected readonly stateTime = computed(() => clockText(this.store.view()?.stateAt ?? null));

  /** Só se define como padrão o que está instalado e ainda não é a tela inicial. */
  protected readonly canSetHome = computed(() => this.idle() && this.installed() && !this.isHome());

  protected setDisableFactory(event: Event): void {
    this.disableFactory.set((event.target as HTMLInputElement).checked);
  }

  protected async setHome(): Promise<void> {
    await this.store.setHome(this.disableFactory());
  }

  /** A pergunta troca o botão no mesmo lugar: o foco acompanha (para "Cancelar", o lado seguro) em vez de se perder. */
  protected askRestore(): void {
    this.confirmingRestore.set(true);
    afterNextRender(() => this.cancelButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancelRestore(): void {
    this.confirmingRestore.set(false);
    afterNextRender(() => this.restoreButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async restore(): Promise<void> {
    this.confirmingRestore.set(false);
    await this.store.restore();
  }
}
