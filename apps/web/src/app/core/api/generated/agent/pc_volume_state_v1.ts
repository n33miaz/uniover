/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: o volume de agora do PC (`level`, 0 a 100, e `muted`) e quando foi lido (`at`). O agente só o manda a uma API que listou `pc.volume.v1` em `features`: na conexão (e quando a API passa a listá-lo), depois de executar `pc.volume.v1` e as teclas de volume e de mudo de `pc.media.v1`, e quando uma leitura periódica mostra que o volume mudou por outro caminho (o teclado do próprio PC). A API o guarda em memória, por agente, e o devolve em `GET /api/v1/pc/status` (`volume`) enquanto o PC está conectado; um agente que não o manda deixa `volume` nulo. Sem resposta.
 */
export interface PcVolumeStateV1Message {
  v: 1;
  id: string;
  type: 'pc.volume.state.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcVolumeStateV1Body;
}
export interface PcVolumeStateV1Body {
  level: number;
  muted: boolean;
  at: string;
}
