import { DOCUMENT } from '@angular/common';
import { HttpInterceptorFn } from '@angular/common/http';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { finalize } from 'rxjs';

/** O que impede uma recarga automática: cada motivo é um tipo de trabalho que a recarga perderia ou cortaria. */
export type UnsavedReason = 'form' | 'request';

/** Uma escrita sem resposta há mais que isto deixa de contar: um pedido que nunca termina não pode travar a recarga para sempre. */
export const REQUEST_MAX_AGE_MS = 30_000;

/** Quantos campos editados a vigia guarda no máximo; passou disso, `form` fica ligado até a conta baixar. */
const MAX_TRACKED_FIELDS = 200;

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

/** Campo em que a pessoa digita: `input`, `textarea` ou região `contenteditable`. */
function isTextField(target: EventTarget | Element | null): target is Field {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

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
    // Dia e hora (`date`, `time`...) costumam ser filtro (o dia do diário), não texto a salvar.
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
      case 'date':
      case 'time':
      case 'datetime-local':
      case 'month':
      case 'week':
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
 * acontece quando ele está vazio; nunca se perde o que a pessoa digitou nem um pedido em voo desta aba. A fila de saída
 * offline não entra: o que espera está gravado no aparelho, e os envios desta aba saem pelo `HttpClient`, que o interceptador
 * já conta (ler o banco compartilhado seguraria a recarga por causa de outra aba).
 *
 * Quatro fontes:
 * - campos de formulário editados pela pessoa e ainda com o valor lá (vigia no `document`, sem cada tela precisar avisar);
 * - fontes registradas por telas e serviços (`register`): um editor sujo. O treino aberto não entra: a sessão fica gravada no
 *   aparelho e a recarga a retoma. Quando uma fonte registrada fica limpa (o editor salvou), os campos vigiados são soltos e
 *   ganham novo ponto de partida; o mesmo vale no `submit` de um formulário;
 * - escritas (`POST/PUT/PATCH/DELETE`) em voo, contadas pelo interceptador `unsavedWorkInterceptor` (as com mais de
 *   `REQUEST_MAX_AGE_MS` deixam de contar). Leituras não contam: uma leitura refeita pela página nova não perde nada, e uma
 *   conexão longa nunca terminaria.
 *
 * Só campos de texto são vigiados (`input`, `textarea`, `contenteditable`). Para uma tela cujo campo é só um filtro ou um
 * controle que age na hora (o passo do treino, o teclado remoto), marque-o com `data-unsaved-ignore`.
 */
@Injectable({ providedIn: 'root' })
export class UnsavedWork {
  private readonly sources = new Map<() => boolean, UnsavedReason>();
  private readonly edited = new Set<Field>();
  /** O valor de cada campo na primeira vez que a pessoa o focou (ver `holdsTypedValue`). */
  private readonly baselines = new WeakMap<Field, string>();
  /** Último estado de cada fonte registrada de `form`, para notar quando ela fica limpa. */
  private readonly sourceWasOn = new Map<() => boolean, boolean>();
  /** Mais campos editados do que cabem na vigia: na dúvida, protege (ver `track`). */
  private overflow = false;
  /** As escritas em voo desta aba e quando cada uma começou. */
  private readonly inFlight = new Map<symbol, number>();

  constructor() {
    const doc = inject(DOCUMENT);
    const remember = (event: Event) => {
      const target = event.target;
      // Só campos de texto: o `textContent` do <main> ou do diálogo focado seria a página inteira na memória.
      if (isTextField(target) && !this.baselines.has(target))
        this.baselines.set(target, valueOf(target));
    };
    const submitted = (event: Event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      for (const element of Array.from(form.elements)) {
        if (!isTextField(element)) continue;
        this.edited.delete(element);
        this.baselines.set(element, valueOf(element));
      }
    };
    const track = (event: Event) => {
      const target = event.target;
      if (!isTextField(target)) return;
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
    doc.addEventListener('submit', submitted, true);
    doc.addEventListener('input', track, true);
    doc.addEventListener('change', track, true);
    inject(DestroyRef).onDestroy(() => {
      doc.removeEventListener('focusin', remember, true);
      doc.removeEventListener('submit', submitted, true);
      doc.removeEventListener('input', track, true);
      doc.removeEventListener('change', track, true);
    });
  }

  /** Registra uma fonte; devolve a função que a retira (chame ao destruir quem registrou). */
  register(source: () => boolean, reason: UnsavedReason = 'form'): () => void {
    this.sources.set(source, reason);
    return () => {
      this.sources.delete(source);
      this.sourceWasOn.delete(source);
    };
  }

  /** Marca o início e o fim de uma escrita em voo. */
  beginRequest(): () => void {
    const token = Symbol('request');
    this.inFlight.set(token, Date.now());
    return () => void this.inFlight.delete(token);
  }

  private hasLiveRequest(): boolean {
    const now = Date.now();
    for (const startedAt of this.inFlight.values())
      if (now - startedAt < REQUEST_MAX_AGE_MS) return true;
    return false;
  }

  /** Todos os motivos ativos agora (sem repetição). */
  reasons(): UnsavedReason[] {
    const found = new Set<UnsavedReason>();
    if (this.hasLiveRequest()) found.add('request');
    let editorSaved = false;
    for (const [source, reason] of this.sources) {
      let on: boolean;
      try {
        on = source();
      } catch {
        // Uma fonte defeituosa não derruba a conferência; na dúvida, protege o trabalho.
        on = true;
      }
      if (on) found.add(reason);
      if (reason === 'form') {
        if (this.sourceWasOn.get(source) && !on) editorSaved = true;
        this.sourceWasOn.set(source, on);
      }
    }
    // Um editor registrado que ficou limpo salvou: os campos dele continuam na tela com o texto digitado, mas já não são
    // trabalho pendente. Ganham novo ponto de partida.
    if (editorSaved) this.rebaseline();
    this.prune();
    if (this.edited.size < MAX_TRACKED_FIELDS) this.overflow = false;
    if (this.edited.size > 0 || this.overflow) found.add('form');
    return [...found];
  }

  hasUnsaved(): boolean {
    return this.reasons().length > 0;
  }

  /** Há algo que só a pessoa pode decidir perder: texto digitado ou um editor sujo (`form`). */
  needsConfirmation(): boolean {
    return this.reasons().includes('form');
  }

  /** Há escrita em voo (pedido desta aba sem resposta): vale esperar terminar, não perguntar. */
  isWriting(): boolean {
    return this.reasons().includes('request');
  }

  /** Os campos vigiados ganham como ponto de partida o texto que têm agora, e a vigia esvazia. */
  private rebaseline(): void {
    for (const field of this.edited) this.baselines.set(field, valueOf(field));
    this.edited.clear();
    this.overflow = false;
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
