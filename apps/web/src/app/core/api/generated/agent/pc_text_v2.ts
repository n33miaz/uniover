/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcTextV2Body = (
  | {
      erase: unknown;
    }
  | {
      text: unknown;
    }
  | {
      key: unknown;
    }
) & {
  erase?: number;
  text?: string;
  key?: PcTextV2BodyKey;
  seq?: number;
  epoch?: string;
};
export type PcTextV2BodyKey = 'ENTER' | 'TAB';

/**
 * API para agente: editar o campo em foco do PC numa mensagem só: apagar `erase` caracteres (Backspace, no máximo 200), digitar `text` e, por fim, apertar `key` (Enter ou Tab), sempre nesta ordem e no mesmo toque no sistema. Pelo menos um dos três vem no corpo. `text` tem 1 a 200 caracteres e, como no `pc.text.v1`, não leva caracteres de controle (Enter e Tab são o `key`). É o que a digitação ao vivo manda: a diferença do campo vai num pedido só, em vez de um por tecla apagada. `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto e a mídia, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`. `epoch` (opcional) identifica a vida da página que numerou o pedido: 16 caracteres hexadecimais aleatórios, sorteados quando a página abre. Sem ela o `seq` não diz de qual página vem (uma página reaberta recomeça a contagem), então o agente só trata o pedido como anterior à troca de caminho quando a época é a mesma que o app declarou no canal direto. A API só a repassa a um agente que declara `pc.rtc.v1`.
 */
export interface PcTextV2Message {
  v: 1;
  id: string;
  type: 'pc.text.v2';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcTextV2Body;
}
