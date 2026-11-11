/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcKeyV2BodyKey =
  | 'ENTER'
  | 'BACKSPACE'
  | 'DELETE'
  | 'TAB'
  | 'ESCAPE'
  | 'SPACE'
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'HOME'
  | 'END'
  | 'PAGE_UP'
  | 'PAGE_DOWN'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'
  | 'D0'
  | 'D1'
  | 'D2'
  | 'D3'
  | 'D4'
  | 'D5'
  | 'D6'
  | 'D7'
  | 'D8'
  | 'D9'
  | 'MINUS'
  | 'EQUALS'
  | 'COMMA'
  | 'PERIOD'
  | 'INSERT'
  | 'PRINT_SCREEN'
  | 'APPS'
  | 'WIN'
  | 'CAPS_LOCK'
  | 'CTRL'
  | 'ALT'
  | 'SHIFT';
export type PcKeyV2BodyModifiersItem = 'CTRL' | 'ALT' | 'SHIFT' | 'WIN';
export type PcKeyV2BodyAction = 'PRESS' | 'DOWN' | 'UP';

/**
 * API para agente: uma tecla do teclado, com modificadores opcionais, repetida em um só pedido (`repeat`) ou apertada e segurada em dois tempos (`action`). A lista de teclas é fechada: o agente nunca digita um código que não esteja aqui. As quatro de pontuação (`MINUS`, `EQUALS`, `COMMA`, `PERIOD`) só são estáveis nos layouts americano e ABNT2; em outros layouts o caractere pode mudar. O resto da pontuação sai pelo `pc.text`. `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto e a mídia, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`. `epoch` (opcional) identifica a vida da página que numerou o pedido: 16 caracteres hexadecimais aleatórios, sorteados quando a página abre. Sem ela o `seq` não diz de qual página vem (uma página reaberta recomeça a contagem), então o agente só trata o pedido como anterior à troca de caminho quando a época é a mesma que o app declarou no canal direto. A API só a repassa a um agente que declara `pc.rtc.v1`.
 */
export interface PcKeyV2Message {
  v: 1;
  id: string;
  type: 'pc.key.v2';
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
  body: PcKeyV2Body;
}
export interface PcKeyV2Body {
  key: PcKeyV2BodyKey;
  /**
   * @maxItems 4
   */
  modifiers?:
    | []
    | [PcKeyV2BodyModifiersItem]
    | [PcKeyV2BodyModifiersItem, PcKeyV2BodyModifiersItem]
    | [PcKeyV2BodyModifiersItem, PcKeyV2BodyModifiersItem, PcKeyV2BodyModifiersItem]
    | [
        PcKeyV2BodyModifiersItem,
        PcKeyV2BodyModifiersItem,
        PcKeyV2BodyModifiersItem,
        PcKeyV2BodyModifiersItem,
      ];
  repeat?: number;
  action?: PcKeyV2BodyAction;
  seq?: number;
  epoch?: string;
}
