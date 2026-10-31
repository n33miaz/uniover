import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';
import { CREDIT_SOURCES } from './credits.data';
import { WgerCredit, WgerCreditsReader } from './wger-credits';

/**
 * Créditos: título, autor, fonte e licença de tudo que é de terceiros, o que foi feito com o material e onde ele
 * aparece. Funciona sem rede: a lista é do próprio app e os autores do wger vêm do banco local. Só os links
 * externos precisam de conexão.
 */
@Component({
  selector: 'app-credits-page',
  imports: [LoadingFrame, RouterLink, Skeleton],
  templateUrl: './credits.page.html',
  styleUrl: './credits.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreditsPage {
  private readonly reader = inject(WgerCreditsReader);

  protected readonly sources = CREDIT_SOURCES;
  protected readonly wgerSource = { url: 'https://wger.de', label: 'wger.de' } as const;
  /** Link que sai do app: sem acesso à janela de origem e sem referência. */
  protected readonly linkRel = 'noopener noreferrer';
  protected readonly wger = signal<readonly WgerCredit[]>([]);
  /** A leitura do banco local ainda não terminou: a seção do wger aparece como esqueleto até lá. */
  protected readonly wgerLoading = signal(true);

  constructor() {
    void this.loadWger();
  }

  protected countText(count: number): string {
    return count === 1
      ? $localize`:@@credits.wger.count-one:1 exercício`
      : $localize`:@@credits.wger.count-many:${count}:count: exercícios`;
  }

  private async loadWger(): Promise<void> {
    try {
      this.wger.set(await this.reader.read());
    } catch {
      // Banco local indisponível: a seção do wger só não aparece; o resto da tela segue valendo.
      this.wger.set([]);
    } finally {
      this.wgerLoading.set(false);
    }
  }
}
