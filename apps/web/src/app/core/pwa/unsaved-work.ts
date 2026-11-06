import { DOCUMENT } from '@angular/common';
import { HttpInterceptorFn } from '@angular/common/http';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { finalize } from 'rxjs';

/** O que impede uma recarga automática: cada motivo é um tipo de trabalho que a recarga perderia ou cortaria. */
export type UnsavedReason = 'form' | 'outbox' | 'request';

/** Quantos campos editados a vigia guarda no máximo; passou disso, `form` fica ligado até a conta baixar. */
const MAX_TRACKED_FIELDS = 200;

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

/** O texto do campo, para guardar como ponto de partida na primeira vez que a pessoa o foca. */
function valueOf(field: Field): string {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) return field.value;
  return field.textContent ?? '';
}

/**
 * O campo guarda texto que a pessoa mudou e que ainda está lá? Só digitação conta, e "mudou" é comparado com o valor que o
 * campo tinha quando a pessoa o focou (`baseline`), não com o atributo `value` (o Angular preenche a propriedade, então o
 * atributo fica vazio): um campo que já vinha preenchido não conta até ser alterado, e apagá-lo conta. Sem ponto de partida
 * (campo alterado sem foco), vale o atributo e só texto não vazio. Caixas de marcar, rádios, interruptores,
 * seletores e controles deslizantes ficam de fora: costumam salvar na hora (nada a perder) e, como o valor continua na
 * tela depois de salvo, travariam a recarga para sempre. Uma tela cujas escolhas só valem ao salvar (um editor) avisa pelo
 * `registerUnsavedWork`, que é a fonte preferida. Busca, botões e campos escondidos também não contam.
 */
function holdsTypedValue(field: Field, baseline: string | undefined): boolean {
  if (!field.isConnected || field.closest('[data-unsaved-ignore]')) return false;
  if (field instanceof HTMLTextAreaElement)
    return baseline === undefined ? field.value !== field.defaultValue : field.value !== baseline;
  if (field instanceof HTMLSelectElement) return false;
  if (field instanceof HTMLInputElement) {
    switch (field.type) {
      case 'search':
      case 'hidden':
      case 'button':
      case 'submit':
      case 'reset':
      case 'range':
      case 'checkbox':
      case 'radio':
      case 'color':
      case 'file':
        return false;
      default:
        return baseline === undefined
          ? field.value !== '' && field.value !== field.defaultValue
          : field.value !== baseline;
    }
  }
  if (!field.isContentEditable) return false;
  return baseline === undefined
    ? (field.textContent ?? '').trim() !== ''
    : (field.textContent ?? '') !== baseline;
}

/**
 * Registro do "trabalho não salvo" da aba. Uma recarga automática (atualização, recuperação de pedaço ausente) só
 * acontece quando ele está vazio; nunca se perde o que a pessoa digitou, a fila de saída offline nem um pedido em voo.
 *
 * Quatro fontes:
 * - campos de formulário editados pela pessoa e ainda com o valor lá (vigia no `document`, sem cada tela precisar avisar);
 * - fontes registradas por telas e serviços (`register`): um editor sujo, a fila offline com itens em voo. O treino aberto não
 *   entra: a sessão fica gravada no aparelho e a recarga a retoma;
 * - escritas (`POST/PUT/PATCH/DELETE`) em voo, contadas pelo interceptador `unsavedWorkInterceptor`. Leituras não contam:
 *   uma leitura refeita pela página nova não perde nada, e uma conexão longa nunca terminaria.
 */
@Injectable({ providedIn: 'root' })
export class UnsavedWork {
  private readonly sources = new Map<() => boolean, UnsavedReason>();
  private readonly edited = new Set<Field>();
  /** O valor de cada campo na primeira vez que a pessoa o focou (ver `holdsTypedValue`). */
  private readonly baselines = new WeakMap<Field, string>();
  private readonly refreshers = new Set<() => Promise<unknown>>();
  /** Mais campos editados do que cabem na vigia: na dúvida, protege (ver `track`). */
  private overflow = false;
  private inFlight = 0;

  constructor() {
    const doc = inject(DOCUMENT);
    const remember = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && !this.baselines.has(target))
        this.baselines.set(target, valueOf(target));
    };
    const track = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // Só entra o campo conectado cujo texto mudou; um campo de volta ao valor de partida sai na hora.
      if (!holdsTypedValue(target, this.baselines.get(target))) {
        this.edited.delete(target);
        return;
      }
      if (this.edited.has(target)) return;
      if (this.edited.size >= MAX_TRACKED_FIELDS) this.prune();
      if (this.edited.size < MAX_TRACKED_FIELDS) this.edited.add(target);
      else this.overflow = true;
    };
    doc.addEventListener('focusin', remember, true);
    doc.addEventListener('input', track, true);
    doc.addEventListener('change', track, true);
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('focusin', remember, true);
      doc.removeEventListener('input', track, true);
      doc.removeEventListener('change', track, true);
    });
  }

  /** Registra uma fonte; devolve a função que a retira (chame ao destruir quem registrou). */
  register(source: () => boolean, reason: UnsavedReason = 'form'): () => void {
    this.sources.set(source, reason);
    return () => this.sources.delete(source);
  }

  /**
   * Registra uma releitura assíncrona de uma fonte cujo valor pode estar velho (a fila de saída lê um banco compartilhado entre
   * abas). `settle` a espera antes de uma decisão.
   */
  registerRefresh(refresh: () => Promise<unknown>): () => void {
    this.refreshers.add(refresh);
    return () => this.refreshers.delete(refresh);
  }

  /** Atualiza as fontes que podem estar velhas, com prazo curto: nunca segura a decisão por muito tempo nem lança. */
  async settle(timeoutMs = 500): Promise<void> {
    if (this.refreshers.size === 0) return;
    const all = Promise.allSettled([...this.refreshers].map((refresh) => refresh()));
    await Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  /** Marca o início e o fim de uma escrita em voo. */
  beginRequest(): () => void {
    this.inFlight++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight--;
    };
  }

  /** Todos os motivos ativos agora (sem repetição). */
  reasons(): UnsavedReason[] {
    const found = new Set<UnsavedReason>();
    if (this.inFlight > 0) found.add('request');
    this.prune();
    if (this.edited.size < MAX_TRACKED_FIELDS) this.overflow = false;
    if (this.edited.size > 0 || this.overflow) found.add('form');
    for (const [source, reason] of this.sources) {
      try {
        if (source()) found.add(reason);
      } catch {
        // Uma fonte defeituosa não derruba a conferência; na dúvida, protege o trabalho.
        found.add(reason);
      }
    }
    return [...found];
  }

  hasUnsaved(): boolean {
    return this.reasons().length > 0;
  }

  /** Há algo que só a pessoa pode decidir perder: texto digitado ou um editor sujo (`form`). */
  needsConfirmation(): boolean {
    return this.reasons().includes('form');
  }

  /** Há escrita em voo (pedido sem resposta ou item da fila já enviado): vale esperar terminar, não perguntar. */
  isWriting(): boolean {
    const reasons = this.reasons();
    return reasons.includes('request') || reasons.includes('outbox');
  }

  /** Solta os campos que saíram da página ou ficaram vazios (a navegação chama isto: nada de tela morta retida). */
  prune(): void {
    for (const field of this.edited)
      if (!holdsTypedValue(field, this.baselines.get(field))) this.edited.delete(field);
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
