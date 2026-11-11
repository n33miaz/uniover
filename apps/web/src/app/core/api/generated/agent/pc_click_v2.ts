/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcClickV2BodyButton = 'LEFT' | 'RIGHT' | 'MIDDLE';
export type PcClickV2BodyAction = 'CLICK' | 'DOUBLE';
export type PcClickV2BodyModifiersItem = 'CTRL' | 'ALT' | 'SHIFT';

/**
 * API para agente: clique do mouse com modificadores e com o intervalo do toque anterior. `modifiers` (opcional): os modificadores são apertados, o clique sai e eles são soltos na ordem inversa, tudo num lote só (Ctrl+clique, Shift+clique); `CTRL`, `ALT` e `SHIFT`, sem o `WIN`, que ao ser solto depois do clique abriria o menu Iniciar. `gapMs` (opcional, 0 a 400): o intervalo, medido no aparelho, entre o toque anterior e este; o agente espera o que faltar para reproduzir esse intervalo desde o último clique que executou (nunca espera mais que `gapMs`; se o pedido chegar mais tarde, executa na hora), para o Windows reconhecer o duplo clique mesmo com a rede irregular. Só `CLICK` e `DOUBLE` (sem `action` vale `CLICK`): apertar e soltar o botão (`DOWN` e `UP`, o arrastar) segue no `pc.click.v1`, que nunca leva modificador. `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto e a mídia, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`. `epoch` (opcional) identifica a vida da página que numerou o pedido: 16 caracteres hexadecimais aleatórios, sorteados quando a página abre. Sem ela o `seq` não diz de qual página vem (uma página reaberta recomeça a contagem), então o agente só trata o pedido como anterior à troca de caminho quando a época é a mesma que o app declarou no canal direto. A API só a repassa a um agente que declara `pc.rtc.v1`.
 */
export interface PcClickV2Message {
  v: 1;
  id: string;
  type: 'pc.click.v2';
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
  body: PcClickV2Body;
}
export interface PcClickV2Body {
  button: PcClickV2BodyButton;
  action?: PcClickV2BodyAction;
  /**
   * @maxItems 3
   */
  modifiers?:
    | []
    | [PcClickV2BodyModifiersItem]
    | [PcClickV2BodyModifiersItem, PcClickV2BodyModifiersItem]
    | [PcClickV2BodyModifiersItem, PcClickV2BodyModifiersItem, PcClickV2BodyModifiersItem];
  gapMs?: number;
  seq?: number;
  epoch?: string;
}
