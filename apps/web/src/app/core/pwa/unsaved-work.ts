import { HttpInterceptorFn } from '@angular/common/http';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { finalize } from 'rxjs';

/** O que impede uma recarga automática: cada motivo é um tipo de trabalho que a recarga perderia ou cortaria. */
export type UnsavedReason = 'form' | 'request';

/** O toque (`isWriting`) deixa de esperar um pedido sem resposta há mais que isto: um envio que nunca termina não o trava. */
export const REQUEST_MAX_AGE_MS = 30_000;
/**
 * A recarga automática não corta uma escrita lenta (um upload), mas também não espera para sempre um pedido pendurado numa
 * rede que não responde (o `HttpClient` não tem prazo): passado este tempo ela deixa de contar.
 */
export const AUTO_REQUEST_MAX_AGE_MS = 5 * 60_000;

/**
 * Registro do "trabalho não salvo" da aba. Uma recarga automática (atualização, recuperação de pedaço ausente) só
 * acontece quando ele está vazio; nunca se perde um editor sujo nem um pedido em voo desta aba. Só há duas fontes, ambas
 * explícitas (nada vigia o `document`):
 * - fontes registradas por telas (`register`, ou `registerUnsavedWork` em quem tem ciclo de vida): o sinal de "sujo" de um
 *   editor ou formulário (o valor atual difere do valor salvo). Quem salva precisa devolver esse sinal a "limpo" antes de
 *   navegar, senão o aviso de versão nova pede "salve ou descarte" para quem já salvou. O treino aberto não entra: a sessão
 *   fica gravada no aparelho e a recarga a retoma. A fila de saída offline também não: o que espera está gravado no aparelho;
 * - escritas (`POST/PUT/PATCH/DELETE`) em voo desta aba, contadas pelo interceptador `unsavedWorkInterceptor` (inclui os envios
 *   da fila, que saem pelo `HttpClient`). Leituras não contam: uma leitura refeita pela página nova não perde nada.
 */
@Injectable({ providedIn: 'root' })
export class UnsavedWork {
  private readonly sources = new Map<() => boolean, UnsavedReason>();
  /** As escritas em voo desta aba e quando cada uma começou. */
  private readonly inFlight = new Map<symbol, number>();
  private readonly afterWritesCallbacks = new Set<() => void>();

  /** Registra uma fonte; devolve a função que a retira (chame ao destruir quem registrou). */
  register(source: () => boolean, reason: UnsavedReason = 'form'): () => void {
    this.sources.set(source, reason);
    return () => this.sources.delete(source);
  }

  /** Marca o início e o fim de uma escrita em voo. */
  beginRequest(): () => void {
    const token = Symbol('request');
    this.inFlight.set(token, Date.now());
    return () => {
      this.inFlight.delete(token);
      if (!this.hasLiveRequest(AUTO_REQUEST_MAX_AGE_MS)) this.flushAfterWrites();
    };
  }

  /** Chama `callback` uma vez, quando a última escrita em voo terminar (quem esperava só por elas pode tentar de novo). */
  afterWrites(callback: () => void): void {
    this.afterWritesCallbacks.add(callback);
  }

  private flushAfterWrites(): void {
    const callbacks = [...this.afterWritesCallbacks];
    this.afterWritesCallbacks.clear();
    for (const callback of callbacks) callback();
  }

  private hasLiveRequest(maxAgeMs: number): boolean {
    const now = Date.now();
    for (const startedAt of this.inFlight.values()) if (now - startedAt < maxAgeMs) return true;
    return false;
  }

  /** As fontes registradas que estão sujas agora (a identidade serve para comparar duas fotografias do estado). */
  dirtySources(): (() => boolean)[] {
    const dirty: (() => boolean)[] = [];
    for (const [source, reason] of this.sources)
      if (reason === 'form' && this.isOn(source)) dirty.push(source);
    return dirty;
  }

  private isOn(source: () => boolean): boolean {
    try {
      return source();
    } catch {
      // Uma fonte defeituosa não derruba a conferência; na dúvida, protege o trabalho.
      return true;
    }
  }

  /** Todos os motivos ativos agora (sem repetição). */
  reasons(): UnsavedReason[] {
    const found = new Set<UnsavedReason>();
    if (this.hasLiveRequest(AUTO_REQUEST_MAX_AGE_MS)) found.add('request');
    for (const [source, reason] of this.sources) if (this.isOn(source)) found.add(reason);
    return [...found];
  }

  hasUnsaved(): boolean {
    return this.reasons().length > 0;
  }

  /** Há algo que só a pessoa pode decidir perder: um editor sujo (`form`). */
  needsConfirmation(): boolean {
    return this.reasons().includes('form');
  }

  /**
   * Há escrita em voo (pedido desta aba sem resposta): vale esperar terminar, não perguntar. Um pedido com mais de
   * `REQUEST_MAX_AGE_MS` deixa de valer a espera.
   */
  isWriting(): boolean {
    return this.hasLiveRequest(REQUEST_MAX_AGE_MS);
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Conta as escritas em voo para o `UnsavedWork` (inclui os reenvios da fila offline, que também saem pelo `HttpClient`). */
export const unsavedWorkInterceptor: HttpInterceptorFn = (request, next) => {
  if (READ_METHODS.has(request.method.toUpperCase())) return next(request);
  const end = inject(UnsavedWork).beginRequest();
  return next(request).pipe(finalize(end));
};

/**
 * Registra uma fonte pelo tempo de vida de quem a chama (tela ou serviço): sai sozinha quando ele é destruído. Chame num
 * inicializador de campo ou no construtor.
 */
export function registerUnsavedWork(source: () => boolean, reason: UnsavedReason = 'form'): void {
  const stop = inject(UnsavedWork).register(source, reason);
  inject(DestroyRef).onDestroy(stop);
}
