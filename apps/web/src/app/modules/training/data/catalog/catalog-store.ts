import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { CatalogQuery, CatalogRepository } from './catalog-repository';
import type { LocalExercise } from './exercise';

/**
 * Estado do catálogo para a tela: os filtros e o resultado, em signals. O resultado vem sempre do banco local e
 * é relido quando o filtro muda ou quando algo grava no catálogo neste aparelho (puxar do servidor, exercício
 * próprio, salto de carga). Gravação feita por outra aba não é vista até o próximo filtro ou gravação aqui.
 */
@Injectable()
export class CatalogStore {
  private readonly repository = inject(CatalogRepository);

  private readonly _query = signal<CatalogQuery>({});
  private readonly _results = signal<readonly LocalExercise[]>([]);
  private readonly _total = signal(0);
  private readonly _ready = signal(false);

  /** Filtros em vigor. */
  readonly query = this._query.asReadonly();
  /** Exercícios que passam nos filtros, já ordenados. */
  readonly results = this._results.asReadonly();
  /** Quantos exercícios existem no catálogo, sem filtro (distingue "nada achado" de "catálogo ainda vazio"). */
  readonly total = this._total.asReadonly();
  /** Verdadeiro depois da primeira leitura do banco local. */
  readonly ready = this._ready.asReadonly();

  // Leituras assíncronas podem terminar fora de ordem; só a do pedido mais recente vale.
  private latest = 0;
  // O total não depende do filtro: só é recontado quando algo grava no catálogo, não a cada letra da busca.
  private countedRevision = -1;

  constructor() {
    effect(() => {
      const query = this._query();
      const revision = this.repository.revision();
      untracked(() => void this.reload(query, revision));
    });
  }

  /** Troca os filtros (campos não citados continuam como estavam). Passar `undefined` num campo o limpa. */
  setQuery(patch: Partial<CatalogQuery>): void {
    this._query.update((current) => ({ ...current, ...patch }));
  }

  clearQuery(): void {
    this._query.set({});
  }

  private async reload(query: CatalogQuery, revision: number): Promise<void> {
    const ticket = ++this.latest;
    const recount = revision !== this.countedRevision;
    try {
      const [results, total] = await Promise.all([
        this.repository.search(query),
        recount ? this.repository.count() : Promise.resolve(this._total()),
      ]);
      if (ticket !== this.latest) return;
      this._results.set(results);
      this._total.set(total);
      this.countedRevision = revision;
    } catch {
      // Banco local que não abre (modo privado, espaço, versão): a tela sai do esqueleto com a lista vazia, em vez de
      // ficar esperando para sempre, e a próxima gravação ou troca de filtro tenta de novo.
      if (ticket !== this.latest) return;
      this._results.set([]);
      this._total.set(0);
    }
    this._ready.set(true);
  }
}
