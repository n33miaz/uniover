/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: resultado de um comando; correlationId aponta o comando.
 */
export interface CommandResultV1Message {
  v: 1;
  id: string;
  type: 'command.result.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string;
  body: CommandResultV1Body;
}
export interface CommandResultV1Body {
  ok: boolean;
  error?: CommandResultV1BodyError;
  /**
   * Só com ok verdadeiro: aviso para o dono sobre um pedido que deu certo (por exemplo, o pacote da TV TCL depois do TV Livre). Só vai à API que lista tv.livre.notice.v1 em features (e ao agente que a declara no hello).
   */
  notice?: string;
}
export interface CommandResultV1BodyError {
  code: string;
  message: string;
}
