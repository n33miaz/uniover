/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcTapV1BodyButton = 'LEFT' | 'RIGHT' | 'MIDDLE';
export type PcTapV1BodyAction = 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP';
export type PcTapV1BodyModifiersItem = 'CTRL' | 'ALT' | 'SHIFT';

/**
 * API para agente: toque na imagem da tela do PC. Leva o ponteiro ao ponto tocado e clica ali, num lote só do sistema (o movimento e o clique nunca se separam). `m` é o monitor como a tela ao vivo o anunciou em `s.mon` (o `id`), e `w` e `h` são a largura e a altura dele em pixels físicos nesse mesmo anúncio. `u` e `v` (0 a 65535) são a posição relativa dentro do monitor: 0 é a borda esquerda (ou de cima) e 65535 o último pixel da direita (ou de baixo). O agente lê os monitores de novo no momento do envio, em pixels físicos e ciente do DPI de cada monitor, e leva o ponteiro ao pixel pela posição absoluta do desktop virtual (o resultado não depende da escala do Windows nem da aceleração do mouse). Se o monitor `m` não existe mais ou mudou de tamanho, a recusa é `stale_layout` e o app espera o próximo `s.mon`. `button` e `action` seguem o `pc.click.v1`: `CLICK` e `DOUBLE` apertam e soltam; `DOWN` e `UP` são as pontas de um arrasto, com o `pc.pointer.abs.v1` no meio. O botão nunca fica preso: o `UP` sempre passa (nem a idade, nem o arranjo dos monitores, nem a janela de administrador o barram; se o arranjo mudou, ele solta sem mover), e a soltura automática do agente vale como no `pc.click.v1`. `modifiers` (opcional, só com `CLICK` e `DOUBLE`) como no `pc.click.v2`. Num ponto coberto por uma janela de administrador o Windows não deixa clicar: a recusa é `elevated_window`, sem enviar o clique. Só existe no canal direto (WebRTC) de controle do PC já autenticado, de um aparelho aprovado, e só enquanto a tela ao vivo daquele mesmo canal está aberta (o que exige a flag `pc_screen` da API, o dono e a permissão `pc:screen`); pela nuvem o agente a recusa com `not_allowed`. O agente só a aceita se declarou a capacidade `pc.abs.v1` (depois de a API listá-la em `features`) e a lista no `ready` do canal.
 */
export interface PcTapV1Message {
  v: 1;
  id: string;
  type: 'pc.tap.v1';
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
  body: PcTapV1Body;
}
export interface PcTapV1Body {
  m: number;
  u: number;
  v: number;
  w: number;
  h: number;
  button: PcTapV1BodyButton;
  action: PcTapV1BodyAction;
  /**
   * @maxItems 3
   */
  modifiers?:
    | []
    | [PcTapV1BodyModifiersItem]
    | [PcTapV1BodyModifiersItem, PcTapV1BodyModifiersItem]
    | [PcTapV1BodyModifiersItem, PcTapV1BodyModifiersItem, PcTapV1BodyModifiersItem];
}
