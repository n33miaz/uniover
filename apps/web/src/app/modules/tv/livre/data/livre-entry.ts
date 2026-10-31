import { Injectable, computed, inject } from '@angular/core';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import type { TvLivreEntryPort } from '../../../../core/modules/tv-livre-entry.port';
import { SessionState } from '../../../../core/session/session-state';
import { TvApi } from '../../data/tv-api';
import { TvSelection } from '../../data/tv-selection';
import { tvHasLivre } from './livre-types';

/** De quanto em quanto tempo, no mínimo, abrir a Início renova a lista de TVs (as capacidades mudam quando o agente é atualizado). */
const REFRESH_EVERY_MS = 60_000;

/**
 * A entrada do TV Livre na Início: o cartão aparece só para o dono, e só quando a TV em uso declara a capacidade
 * `tv.livre.v1`. A lista de TVs (com as capacidades) é a mesma que o controle usa e vive em `TvSelection`; como a Início abre
 * antes de o controle existir, é ela quem pede a lista, no máximo uma vez por minuto e por conta. Qualquer falha (sem rede,
 * servidor antigo, sessão a confirmar) só deixa o cartão escondido: nada aqui rejeita nem avisa.
 */
@Injectable({ providedIn: 'root' })
export class TvLivreEntry implements TvLivreEntryPort {
  private readonly api = inject(TvApi);
  private readonly selection = inject(TvSelection);
  private readonly session = inject(SessionState);
  private readonly connectivity = inject(ConnectivityService);

  private askedAt = 0;
  private askedFor: string | null = null;
  private asking = false;

  readonly available = computed(
    () => this.session.role() === 'owner' && tvHasLivre(this.selection.selected()),
  );

  refresh(): void {
    void this.ask();
  }

  private async ask(): Promise<void> {
    const account = this.session.accountId();
    if (this.session.role() !== 'owner' || account === null) return;
    if (!this.connectivity.online() || this.asking) return;
    const now = Date.now();
    if (account === this.askedFor && now - this.askedAt < REFRESH_EVERY_MS) return;
    this.asking = true;
    try {
      const list = await this.api.tvs();
      // A conta pode ter trocado durante a espera: a lista é de quem a pediu.
      if (this.session.accountId() === account) {
        this.selection.setTvs(list);
        this.askedFor = account;
        this.askedAt = now;
      }
    } catch {
      // Cartão escondido: a Início não mostra erro de uma coisa que a pessoa nem pediu.
    } finally {
      this.asking = false;
    }
  }
}
