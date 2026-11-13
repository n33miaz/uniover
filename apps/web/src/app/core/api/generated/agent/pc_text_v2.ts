/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcTextV2BodyKey = 'ENTER' | 'TAB';
export type PcTextV2BodyTarget = 'browser' | 'spotify' | 'vlc';

/**
 * API para agente: editar o campo em foco do PC numa mensagem só: apagar `erase` caracteres (Backspace, no máximo 200), digitar `text` e, por fim, apertar `key` (Enter ou Tab), sempre nesta ordem e no mesmo toque no sistema. Pelo menos um dos três vem no corpo. `text` tem 1 a 200 caracteres e, como no `pc.text.v1`, não leva caracteres de controle (Enter e Tab são o `key`). É o que a digitação ao vivo manda: a diferença do campo vai num pedido só, em vez de um por tecla apagada. `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto e a mídia, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`. `epoch` (opcional) identifica a vida da página que numerou o pedido: 16 caracteres hexadecimais aleatórios, sorteados quando a página abre. Sem ela o `seq` não diz de qual página vem (uma página reaberta recomeça a contagem), então o agente só trata o pedido como anterior à troca de caminho quando a época é a mesma que o app declarou no canal direto. A API só a repassa a um agente que declara `pc.rtc.v1`. `target` (opcional) é o programa que precisa estar em primeiro plano no PC (`browser`: Chrome, Edge, Firefox, Brave ou Opera; `spotify`; `vlc`): se a janela da frente é de outro programa, o agente não aperta nada e recusa com `app_not_in_front`. A API só o repassa a um agente que declara `pc.target.v1`; sem ele o comando vai para a janela da frente, como sempre.
 */
export interface PcTextV2Message {
  v: 1;
  id: string;
  type: 'pc.text.v2';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  /**
   * Identificador da operação (opcional): o mesmo do pedido HTTP que originou o comando do PC (`X-Operation-Id`), para ligar o registro da API ao do agente. Só aparece em comandos `pc.*` que NÃO são o movimento do mouse e só vai a um agente que declarou a capacidade `pc.op.v1` (o esquema de um agente anterior é fechado e recusaria a mensagem inteira). Nunca leva texto, teclas nem coordenadas: é só um código.
   */
  operationId?: string;
  /**
   * O aparelho do app que originou o comando do PC (opcional): um código estável da sessão (a família da sessão do app). Vem junto com `deviceName`, o nome para mostrar ao dono na pergunta "Permitir que <nome> controle este PC?". Só vai a um agente que declarou a capacidade `pc.device.v1` (a aprovação de aparelho novo no PC) e vale também para a oferta do canal direto: o canal herda o aparelho da oferta.
   */
  deviceId?: string;
  /**
   * O nome do aparelho para a pergunta de aprovação no PC (ver `deviceId`): até 60 caracteres, sem texto de controle.
   */
  deviceName?: string;
  body: PcTextV2Body;
}
export interface PcTextV2Body {
  erase?: number;
  text?: string;
  key?: PcTextV2BodyKey;
  seq?: number;
  epoch?: string;
  target?: PcTextV2BodyTarget;
}
