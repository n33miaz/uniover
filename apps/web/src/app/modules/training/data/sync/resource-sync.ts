import { InjectionToken, type Provider, type Type } from '@angular/core';

/** Uma página da leitura incremental, no formato de todo recurso sincronizável do módulo. */
export interface PullPage<T> {
  readonly items: readonly T[];
  /** Cursor da última linha entregue (texto opaco). */
  readonly nextCursor: string | null;
}

/** Tamanho de página pedido por padrão (o padrão do servidor; o máximo dele é 500). */
export const DEFAULT_PULL_PAGE_SIZE = 200;

/**
 * Contrato de um recurso sincronizável: o puxador genérico (`TrainingSync`) cuida de cursor, páginas, fila e
 * gatilhos; cada recurso só diz **qual** é e **como** guardar o que veio. Recurso novo = uma classe que implementa
 * isto e uma linha em `training-data.providers.ts` (`provideResourceSync`).
 */
export interface ResourceSync<TRemote = unknown> {
  /** Nome estável, usado como chave do cursor na tabela `syncState`. Nunca mude depois de publicado. */
  readonly resource: string;
  /** Caminho do `GET` incremental (`?after=&limit=`), começando por `/api/`. */
  readonly path: string;
  /** Linhas por página; o padrão é `DEFAULT_PULL_PAGE_SIZE`. */
  readonly pageSize?: number;
  /** Funde uma página no banco local (com `mergeById`: nunca apaga linha por ausência). */
  merge(items: readonly TRemote[]): Promise<void>;
}

export const TRAINING_RESOURCE_SYNCS = new InjectionToken<readonly ResourceSync[]>(
  'TRAINING_RESOURCE_SYNCS',
);

/** Registra um recurso no puxador. É a "uma linha por recurso" de `provideTrainingData`. */
export function provideResourceSync(resource: Type<ResourceSync>): Provider {
  return { provide: TRAINING_RESOURCE_SYNCS, useClass: resource, multi: true };
}
