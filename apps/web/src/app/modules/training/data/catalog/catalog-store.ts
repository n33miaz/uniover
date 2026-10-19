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

  constructor() {
    effect(() => {
      const query = this._query();
      this.repository.revision();
      untracked(() => void this.reload(query));
    });
  }

  /** Troca os filtros (campos não citados continuam como estavam). Passar `undefined` num campo o limpa. */
  setQuery(patch: Partial<CatalogQuery>): void {
    this._query.update((current) => ({ ...current, ...patch }));
  }

  clearQuery(): void {
    this._query.set({});
  }

  private async reload(query: CatalogQuery): Promise<void> {
    const ticket = ++this.latest;
    const [results, total] = await Promise.all([
      this.repository.search(query),
      this.repository.count(),
    ]);
    if (ticket !== this.latest) return;
    this._results.set(results);
    this._total.set(total);
    this._ready.set(true);
  }
}
