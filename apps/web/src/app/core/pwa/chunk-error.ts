import { ErrorHandler, Injectable, Injector, inject } from '@angular/core';
import { NavigationError } from '@angular/router';
import { PwaUpdateService } from './pwa-update.service';

/**
 * Mensagens que os navegadores dão quando um arquivo de código carregado sob demanda não existe mais. Acontece
 * quando a casca antiga (já aberta) pede um pedaço do app que o deploy novo trocou de nome: o Chromium diz "Failed to
 * fetch dynamically imported module", o Firefox "error loading dynamically imported module", o Safari "Importing a
 * module script failed", e bundlers antigos "Loading chunk N failed".
 */
const CHUNK_LOAD_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk [\w-]+ failed|ChunkLoadError/i;

/** Quantas camadas de causa são lidas (o Angular e as promessas embrulham o erro original). */
const MAX_DEPTH = 4;

/** Reconhece o erro de pedaço de código ausente, mesmo embrulhado em `cause`, `rejection` ou `ngOriginalError`. */
export function isChunkLoadError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
    if (typeof current === 'string') return CHUNK_LOAD_ERROR.test(current);
    if (typeof current !== 'object') return false;
    const candidate = current as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      rejection?: unknown;
      ngOriginalError?: unknown;
    };
    const text = `${String(candidate.name ?? '')}: ${String(candidate.message ?? '')}`;
    if (CHUNK_LOAD_ERROR.test(text)) return true;
    current = candidate.cause ?? candidate.rejection ?? candidate.ngOriginalError;
  }
  return false;
}

/**
 * Para `withNavigationErrorHandler`: a rota que falha por pedaço ausente atualiza o app sozinha (uma vez por vez, com
 * guarda contra laço) em vez de deixar a tela vazia.
 */
export function recoverFromChunkNavigationError(event: NavigationError): void {
  if (isChunkLoadError(event.error)) inject(PwaUpdateService).recoverFromStaleShell(event.url);
}

/**
 * Pega o que escapa da rota: a promessa de uma importação dinâmica sem dono (a fila offline, por exemplo) ou um erro
 * de renderização. Se a recuperação já está em curso o erro não é registrado de novo; fora isso, segue o
 * comportamento padrão.
 */
@Injectable()
export class ChunkAwareErrorHandler extends ErrorHandler {
  private readonly injector = inject(Injector);

  override handleError(error: unknown): void {
    if (isChunkLoadError(error) && this.injector.get(PwaUpdateService).recoverFromStaleShell())
      return;
    super.handleError(error);
  }
}
