import { Signal } from '@angular/core';

export type AgentState = 'unknown' | 'online' | 'offline';
export type WatcherState = 'unknown' | 'ok' | 'alert';

/** O que a faixa de informações da Início precisa saber. */
export interface HomeStatus {
  /** Nome para a saudação; `null` até haver sessão. */
  readonly userName: string | null;
  readonly agent: AgentState;
  readonly watcher: WatcherState;
  readonly serviceDown: boolean;
  /**
   * A TV desta conta tem um agente vinculado? `false`: nenhum ponto (não há agente dela); `null`: ainda não se sabe.
   * O agente é sempre o da própria conta (o do dono para o dono, o do convidado para ele), nunca o de outra pessoa.
   */
  readonly agentLinked: boolean | null;
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
