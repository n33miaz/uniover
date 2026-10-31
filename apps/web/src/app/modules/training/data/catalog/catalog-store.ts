import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { CatalogQuery, CatalogRepository } from './catalog-repository';
import type { LocalExercise } from './exercise';

/**
 * Quanto a leitura do banco local pode levar antes de virar erro. Leitura em lote leva milissegundos; passar disto é um
 * banco travado (outra aba segurando, aparelho sem memória), e a tela precisa sair do esqueleto com o "Tentar de Novo".
 */
export const READ_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('catalog read timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  private readonly _failed = signal(false);

  /** Filtros em vigor. */
  readonly query = this._query.asReadonly();
  /** Exercícios que passam nos filtros, já ordenados. */
  readonly results = this._results.asReadonly();
  /** Quantos exercícios existem no catálogo, sem filtro (distingue "nada achado" de "catálogo ainda vazio"). */
  readonly total = this._total.asReadonly();
  /** Verdadeiro depois da primeira leitura do banco local. */
  readonly ready = this._ready.asReadonly();
  /** A última leitura do banco local falhou ou estourou o prazo: a tela mostra o erro com "Tentar de Novo". */
  readonly failed = this._failed.asReadonly();

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

  /** "Tentar de Novo": refaz a leitura do filtro atual, recontando o total. */
  retry(): void {
    this.countedRevision = -1;
    void this.reload(this._query(), this.repository.revision());
  }

  private async reload(query: CatalogQuery, revision: number): Promise<void> {
    const ticket = ++this.latest;
    const recount = revision !== this.countedRevision;
    try {
      const [results, total] = await withTimeout(
        Promise.all([
          this.repository.search(query),
          recount ? this.repository.count() : Promise.resolve(this._total()),
        ]),
        READ_TIMEOUT_MS,
      );
      if (ticket !== this.latest) return;
      this._results.set(results);
      this._total.set(total);
      this._failed.set(false);
      this.countedRevision = revision;
    } catch {
      // Banco local que não abre (modo privado, espaço, versão) ou que não responde: a tela sai do esqueleto com o erro e
      // o "Tentar de Novo", em vez de ficar esperando para sempre. A próxima gravação ou troca de filtro também refaz.
      if (ticket !== this.latest) return;
      this._results.set([]);
      this._total.set(0);
      this._failed.set(true);
    }
    this._ready.set(true);
  }
}
