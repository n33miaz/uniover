/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: zoom pela roda do mouse com o Ctrl apertado (a pinça do app). `steps` (-12 a 12, nunca 0): quantos cliques de roda; positivo aproxima (a roda para cima, como Ctrl+roda nos navegadores e nos editores), negativo afasta. O agente aperta o Ctrl, gira a roda `|steps|` vezes e solta o Ctrl num lote só do sistema: o Ctrl nunca fica preso (um lote aceito só em parte, a queda do canal direto e a da conexão com a API soltam o que tiver ficado apertado); se o Ctrl já está segurado por um `pc.key.v2` `DOWN`, ele não é apertado de novo nem solto. Responde com `command.result.v1`. A API só a usa para o agente que declarou a capacidade `pc.pointer.zoom.v1` (depois de a API listá-la em `features`); para um agente sem ela o pedido volta como 409 `pc-key-unsupported`, sem enviar nada. `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto, a mídia, o zoom e o volume, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`. `epoch` (opcional) identifica a vida da página que numerou o pedido: 16 caracteres hexadecimais aleatórios, sorteados quando a página abre. Sem ela o `seq` não diz de qual página vem (uma página reaberta recomeça a contagem), então o agente só trata o pedido como anterior à troca de caminho quando a época é a mesma que o app declarou no canal direto. A API só a repassa a um agente que declara `pc.rtc.v1`.
 */
export interface PcPointerZoomV1Message {
  v: 1;
  id: string;
  type: 'pc.pointer.zoom.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcPointerZoomV1Body;
}
export interface PcPointerZoomV1Body {
  steps: number;
  seq?: number;
  epoch?: string;
}
