import { Injectable, computed, inject } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { TvAccess } from './tv-access';
import { TvStore } from './tv-store';

/** Onde está o passo a passo de quando a internet cai. */
export const TV_OFFLINE_GUIDE_ROUTE = '/tv/internet';
/** Onde está o passo a passo de configurar a TV (qual computador a controla). */
export const TV_SETUP_ROUTE = '/tv/configurar';

/** Um guia que a ajuda oferece: o texto da linha e para onde ela leva. */
export interface TvHelpGuide {
  readonly route: string;
  readonly label: string;
}

/**
 * Os guias que esta conta pode abrir pela linha "Ajuda" do menu: o de quando a internet cai (de quem controla a TV ou a
 * administra) e o de configurar a TV (só do administrador, e não na própria tela de configurar). O menu e a folha de ajuda
 * leem daqui, para concordarem sobre o que existe.
 */
@Injectable({ providedIn: 'root' })
export class TvHelpGuides {
  private readonly access = inject(TvAccess);
  private readonly store = inject(TvStore);
  private readonly isGuest = inject(SessionState).isGuest;

  readonly list = computed<readonly TvHelpGuide[]>(() => {
    const owner = !this.isGuest();
    const guides: TvHelpGuide[] = [];
    if (this.access.control() || owner) {
      guides.push({
        route: TV_OFFLINE_GUIDE_ROUTE,
        label: $localize`:@@tv.help.offline-guide:Se a internet cair`,
      });
    }
    if (owner && this.store.status() !== 'unconfigured') {
      guides.push({
        route: TV_SETUP_ROUTE,
        label: $localize`:@@tv.help.setup-guide:Ajuda para Configurar`,
      });
    }
    return guides;
  });
}
