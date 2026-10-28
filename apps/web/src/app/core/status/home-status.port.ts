import { Signal } from '@angular/core';

export type AgentState = 'unknown' | 'online' | 'offline';
export type WatcherState = 'unknown' | 'ok' | 'alert';

/** O aviso de queda do computador: o nome dele e se já voltou. Só o dono recebe. */
export interface AgentAlertNote {
  readonly name: string;
  readonly recovered: boolean;
}

/** O que a faixa de informações da Início precisa saber. */
export interface HomeStatus {
  /** Nome para a saudação; `null` até haver sessão. */
  readonly userName: string | null;
  readonly agent: AgentState;
  readonly watcher: WatcherState;
  readonly serviceDown: boolean;
  /** Aviso de queda ainda não visto (nulo sem aviso ou fora do dono). */
  readonly agentAlert?: AgentAlertNote | null;
}

/**
 * Porta de leitura do estado da casa. A Início depende só dela; quem fala com a API e com o fluxo em tempo real é o
 * adaptador registrado na composição do app, e os testes da tela trocam por um duplo. Sem dado, o adaptador diz
 * "sem dados" em vez de inventar um estado.
 */
export abstract class HomeStatusPort {
  abstract readonly status: Signal<HomeStatus>;
  /** Só fica verdadeiro após uma espera curta sem nenhum estado salvo para desenhar. */
  abstract readonly loading: Signal<boolean>;

  /**
   * A tela chama ao aparecer: enquanto houver quem acompanhe, o adaptador mantém o estado fresco (e só então
   * consulta a API ou abre o fluxo). Devolve a função que encerra o acompanhamento, para a tela chamar ao sair.
   */
  abstract watch(): () => void;
}
