import { InjectionToken } from '@angular/core';

/** Ajustes do controle. A API não expõe estes valores, então ficam aqui, num ponto só e fáceis de trocar. */
export interface TvConfig {
  /** Espera curta antes de desenhar o esqueleto: uma leitura rápida não pisca. */
  readonly skeletonDelayMs: number;
  /**
   * Quanto a primeira leitura (estado ou atalhos) pode demorar antes de virar "sem resposta". Até lá o controle fica
   * verde e o esqueleto é o único sinal de espera. A leitura vem da memória do servidor (não espera o agente), então
   * 8 s já é muito; a API espera até 25 s só pelo comando do agente, e isso não conta aqui. O relógio fica parado
   * enquanto o servidor acorda (partida a frio), que sozinho levaria a leitura além disso.
   */
  readonly readTimeoutMs: number;
  /**
   * Quanto tempo, depois de pedir que o controle acorde, a sessão dormindo conta como "acordando" (verde). Passado o
   * prazo sem o estado mudar, ela aparece como dormindo de verdade.
   */
  readonly wakeGraceMs: number;
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
  /**
   * Cauda do envio do texto da aba Teclado: a primeira mudança depois de uma pausa vai na hora, e daí em diante dois
   * envios nunca começam com menos que isto de intervalo (o que se digita nesse meio tempo vai junto, só o mais
   * recente). Menor é mais rápido e manda mais requisições; maior junta mais letras por requisição.
   */
  readonly textTailMs: number;
  /**
   * Freio do ritmo do texto: no máximo `textMaxRequests` envios em qualquer janela deslizante de `textWindowMs`.
   * O servidor aceita 300 comandos por minuto por pessoa, num balde só para teclas, aquecer e abrir app, e a cauda
   * sozinha deixaria uma digitação contínua com a TV respondendo rápido chegar a 10 por segundo (600 por minuto).
   * 40 a cada 10 s dá no máximo 240 por minuto de texto, sobrando 60 por minuto para o resto, e ainda deixa uma
   * rajada de 40 envios sair sem esperar.
   */
  readonly textMaxRequests: number;
  readonly textWindowMs: number;
  /** Quantas teclas sem resposta ainda cabem antes de a repetição esperar. */
  readonly maxKeysInFlight: number;
}

export const TV_CONFIG = new InjectionToken<TvConfig>('TV_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    skeletonDelayMs: 200,
    readTimeoutMs: 8_000,
    wakeGraceMs: 8_000,
    hibernateMinutes: 5,
    wakeIntervalMs: 120_000,
    repeatDelayMs: 400,
    repeatIntervalMs: 250,
    noticeMs: 6_000,
    textTailMs: 100,
    textMaxRequests: 40,
    textWindowMs: 10_000,
    maxKeysInFlight: 3,
  }),
});
