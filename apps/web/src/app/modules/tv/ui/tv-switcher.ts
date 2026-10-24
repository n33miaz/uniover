import { Component, computed, inject, output } from '@angular/core';
import { TvPhase, statusLabel } from '../data/tv-status';
import { TvStore } from '../data/tv-store';
import { TvSummary } from '../data/tv-types';
import { StatusDot } from './status-dot';
import { TvIcon } from './tv-icon';

/**
 * Conteúdo da folha que troca de TV (vai dentro de um `TvPanel`, que cuida do fundo, do Esc, da saída e do foco). Uma
 * linha por TV que a conta vê, com o nome e o ponto de estado (o agente dela está ligado ou não); a que está em uso traz
 * o visto e `aria-current`. Escolher a mesma TV só fecha a folha. Ao abrir, a lista é renovada para os pontos refletirem o
 * agora, sem esperar pela próxima rodada.
 */
@Component({
  selector: 'app-tv-switcher',
  imports: [StatusDot, TvIcon],
  templateUrl: './tv-switcher.html',
  styleUrl: './tv-switcher.css',
})
export class TvSwitcher {
  private readonly store = inject(TvStore);

  protected readonly tvs = computed(() => this.store.tvs() ?? []);
  protected readonly currentId = computed(() => this.store.selectedTv()?.id ?? null);

  /** A pessoa escolheu uma TV (a página troca e fecha a folha). */
  readonly pick = output<string>();

  constructor() {
    void this.store.refreshTvs();
  }

  protected phase(tv: TvSummary): TvPhase {
    return tv.online ? 'connected' : 'agent-off';
  }

  /** O estado em palavras, para o leitor de tela (o ponto é só desenho). */
  protected stateText(tv: TvSummary): string {
    return statusLabel(tv.online ? 'hot' : 'agent-off');
  }
}
