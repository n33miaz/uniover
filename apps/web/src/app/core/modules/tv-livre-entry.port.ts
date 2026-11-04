import { InjectionToken, Signal, signal } from '@angular/core';

/** O que o agente da TV anuncia ao conectar quando sabe cuidar do launcher próprio (TV Livre). */
export const TV_LIVRE_CAPABILITY = 'tv.livre.v1';

/**
 * O que a Início precisa saber da entrada do TV Livre: se o cartão aparece (conta do dono e TV atual com a capacidade
 * `tv.livre.v1`). Quem sabe qual é a TV atual e fala com a API é o módulo da TV, que a Início não pode importar; o
 * adaptador real é registrado na composição do app (como o `HomeStatusPort`).
 */
export interface TvLivreEntryPort {
  readonly available: Signal<boolean>;
  /** A Início chama ao abrir: renova a lista de TVs (no máximo de tempos em tempos), sem nunca rejeitar. */
  refresh(): void;
}

/**
 * Sem adaptador registrado (e nos testes das outras telas) o cartão não aparece: ao contrário dos botões do controle,
 * aqui esconder por falta de informação é o certo, porque instalar outro launcher numa TV que talvez não o suporte não
 * pode ser oferecido no escuro.
 */
export const TV_LIVRE_ENTRY = new InjectionToken<TvLivreEntryPort>('TV_LIVRE_ENTRY', {
  providedIn: 'root',
  factory: () => ({ available: signal(false).asReadonly(), refresh: () => undefined }),
});
