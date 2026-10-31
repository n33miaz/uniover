import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { closeDialog, leaveDialog, onDialogBackdropClick } from '../../../shared/ui/dialog-motion';
import { CREDIT_SOURCES } from './credits.data';
import { WgerCredit, WgerCreditsReader } from './wger-credits';

/**
 * Créditos: título, autor, fonte e licença de tudo que é de terceiros, o que foi feito com o material e onde ele
 * aparece. Funciona sem rede: a lista é do próprio app e os autores do wger vêm do banco local. Só os links
 * externos precisam de conexão. Abre como folha por cima de Sobre, com cada fonte recolhida até ser tocada.
 */
@Component({
  selector: 'app-credits-page',
  templateUrl: './credits.page.html',
  styleUrl: './credits.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreditsPage {
  private readonly reader = inject(WgerCreditsReader);
  private readonly router = inject(Router);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly sources = CREDIT_SOURCES;
  protected readonly wgerSource = { url: 'https://wger.de', label: 'wger.de' } as const;
  /** Link que sai do app: sem acesso à janela de origem e sem referência. */
  protected readonly linkRel = 'noopener noreferrer';
  protected readonly wger = signal<readonly WgerCredit[]>([]);

  constructor() {
    void this.loadWger();
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.close());
    });
  }

  /** Esc também passa por aqui: a folha desce e só então a rota volta para Sobre. */
  protected close(event?: Event): void {
    event?.preventDefault();
    const dialog = this.dialog().nativeElement;
    leaveDialog(dialog, () => {
      closeDialog(dialog);
      void this.router.navigateByUrl('/ajustes/sobre', { replaceUrl: true });
    });
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
    }
  }
}
