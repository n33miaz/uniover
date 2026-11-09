/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: digitar um texto no campo em foco do PC, caractere a caractere. 1 a 200 caracteres, sem caracteres de controle (Enter e Tab são teclas em `pc.key.v1`). `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto e a mídia, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`. `epoch` (opcional) identifica a vida da página que numerou o pedido: 16 caracteres hexadecimais aleatórios, sorteados quando a página abre. Sem ela o `seq` não diz de qual página vem (uma página reaberta recomeça a contagem), então o agente só trata o pedido como anterior à troca de caminho quando a época é a mesma que o app declarou no canal direto. A API só a repassa a um agente que declara `pc.rtc.v1`.
 */
export interface PcTextV1Message {
  v: 1;
  id: string;
  type: 'pc.text.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcTextV1Body;
}
export interface PcTextV1Body {
  text: string;
  seq?: number;
  epoch?: string;
}
