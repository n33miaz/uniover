import { InjectionToken } from '@angular/core';

/** Ajustes do controle. A API não expõe estes valores, então ficam aqui, num ponto só e fáceis de trocar. */
export interface TvConfig {
  /** Tempo que a sessão com a TV espera sem comandos antes de dormir (só para o aviso na tela). */
  readonly hibernateMinutes: number;
  /** Intervalo do pedido de "aquecer" enquanto a tela está visível. */
  readonly wakeIntervalMs: number;
  /** Quanto o dedo precisa ficar parado numa tecla repetível antes de a repetição começar. */
  readonly repeatDelayMs: number;
  /** Intervalo da repetição (cerca de 4 por segundo, abaixo do limite de comandos do servidor). */
  readonly repeatIntervalMs: number;
  /** Quanto tempo um aviso fica na tela. */
  readonly noticeMs: number;
  /** Quantas teclas sem resposta ainda cabem antes de a repetição esperar. */
  readonly maxKeysInFlight: number;
}

export const TV_CONFIG = new InjectionToken<TvConfig>('TV_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    hibernateMinutes: 5,
    wakeIntervalMs: 120_000,
    repeatDelayMs: 400,
    repeatIntervalMs: 250,
    noticeMs: 6_000,
    maxKeysInFlight: 3,
  }),
});
