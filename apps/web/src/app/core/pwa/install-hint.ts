import { DOCUMENT } from '@angular/common';
import { Component, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { SessionState } from '../session/session-state';
import { InstallHintSheet } from './install-hint-sheet';
import { InstallHintService } from './install-hint.service';

/** Quanto esperar, depois de a tela estar pronta, para a folha abrir sozinha (ms). */
export const INSTALL_HINT_DELAY_MS = 3000;

/** Se a página está ocupada no fim do prazo, arma outro, até esta quantidade de vezes. */
export const INSTALL_HINT_MAX_ATTEMPTS = 10;

/**
 * Hospeda a folha "Atalho na tela de início" na casca e a abre sozinha uma vez, para quem entrou (dono ou
 * convidado) num celular, fora do app instalado. Nada fica fixo na tela: sem a folha aberta este componente não
 * desenha nada, então o controle da TV (apertado) não ganha elemento algum.
 *
 * Abre sozinha com a sessão confirmada e ~3 s depois da tela pronta; o prazo é cancelável (sair da sessão, mudar
 * a condição ou destruir a casca o desarma). No fim do prazo confere de novo: com a página em segundo plano, ainda
 * carregando, numa navegação ou com outro diálogo aberto (passkey, apps da TV...), não interrompe e arma outro
 * prazo. Também hospeda a abertura manual, pedida pelas linhas de Ajustes e de Personalizar
 * (`InstallHintService.open`), que ignora o "Agora não".
 *
 * O foco volta sozinho a quem abriu a folha: `leave` da folha chama `dialog.close()`, que o devolve.
 */
@Component({
  selector: 'app-install-hint',
  imports: [InstallHintSheet],
  template: `
    @if (hint.sheet(); as origin) {
      <app-install-hint-sheet [manual]="origin === 'manual'" (closed)="hint.closeSheet()" />
    }
  `,
})
export class InstallHint {
  protected readonly hint = inject(InstallHintService);
  private readonly session = inject(SessionState);
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);

  constructor() {
    // O pedido do navegador (Chromium) chega uma vez, cedo: o ouvinte precisa estar de pé antes de qualquer tela.
    this.hint.start();

    effect((onCleanup) => {
      if (!this.session.isAuthenticated() || !this.hint.autoEligible() || this.hint.sheet()) return;
      let attempts = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        timer = setTimeout(attempt, INSTALL_HINT_DELAY_MS);
      };
      const attempt = () => {
        if (!this.hint.autoOpenAllowed()) return; // algo mudou (instalou, disse "nunca"): não abre
        if (this.busy()) {
          if (++attempts < INSTALL_HINT_MAX_ATTEMPTS) arm();
          return;
        }
        this.hint.openAuto();
      };
      arm();
      onCleanup(() => clearTimeout(timer));
    });
  }

  /** A página não está pronta para uma interrupção: em segundo plano, carregando, navegando ou com outro diálogo. */
  private busy(): boolean {
    const doc = this.doc;
    return (
      doc.visibilityState !== 'visible' ||
      doc.readyState !== 'complete' ||
      this.router.currentNavigation() !== null ||
      doc.querySelector('dialog[open]') !== null
    );
  }
}
