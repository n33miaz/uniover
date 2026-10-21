import { Location } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

/**
 * "Voltar" das telas de segundo nível (ficha, formulário, editor). Dentro da sessão do app volta uma entrada do
 * histórico, que traz a lista como estava (filtros e posição); quando a tela foi aberta direto pelo endereço, não há
 * entrada anterior do app e vai para `fallback`.
 */
@Injectable({ providedIn: 'root' })
export class BackNavigation {
  private readonly location = inject(Location);
  private readonly router = inject(Router);

  back(fallback: string): void {
    // O roteador numera as navegações e guarda o número no estado do histórico: 1 é a primeira da sessão da página.
    const state = this.location.getState() as { navigationId?: number } | null;
    if ((state?.navigationId ?? 0) > 1) this.location.back();
    else void this.router.navigateByUrl(fallback);
  }
}
