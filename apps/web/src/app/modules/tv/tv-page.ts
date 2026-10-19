import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { TV_CONFIG } from './data/tv-config';
import { StatusTone, statusLabel, statusTone } from './data/tv-status';
import { TvStore } from './data/tv-store';
import { PowerSheet } from './ui/power-sheet';
import { TvIcon } from './ui/tv-icon';

/**
 * Casca do módulo da TV: cabeçalho (voltar ao Início, nome com a bolinha de estado, energia), chips de estado e a
 * rota filha da aba aberta (Controle, Apps ou Teclado). O estado da TV (`TvStore`) é um só e as três abas o
 * compartilham; ele só fala com o servidor enquanto esta tela existe (ao sair, o fluxo e o "aquecer" param). Fica
 * na raiz, e não nos `providers` do componente, porque o recurso de providers de componente puxaria código do
 * Angular para o pacote inicial.
 */
@Component({
  selector: 'app-tv-page',
  imports: [RouterLink, RouterOutlet, TvIcon, PowerSheet],
  templateUrl: './tv-page.html',
  styleUrl: './tv-page.css',
})
export class TvPage {
  protected readonly store = inject(TvStore);
  protected readonly hibernateMinutes = inject(TV_CONFIG).hibernateMinutes;

  protected readonly powerOpen = signal(false);

  protected readonly label = computed(() => statusLabel(this.store.status()));
  protected readonly tone = computed<StatusTone>(() => statusTone(this.store.status()));

  /** Sem rede, o último estado recebido continua à vista com a hora ("visto às 14:02: controle dormindo"). */
  protected readonly lastSeen = computed<string | null>(() => {
    if (this.store.status() !== 'offline') return null;
    const known = this.store.lastKnownStatus();
    const time = this.store.seenAtText();
    if (known === null || !time) return null;
    const text = statusLabel(known);
    return $localize`:@@tv.chip.last-seen:visto às ${time}:time: · ${text}:text:`;
  });

  constructor() {
    // O store só abre o fluxo e começa a "aquecer" quando a tela nasce e para quando ela é destruída.
    this.store.start();
    inject(DestroyRef).onDestroy(() => this.store.stop());
  }
}
