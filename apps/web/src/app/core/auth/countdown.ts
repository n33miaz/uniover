import { DOCUMENT } from '@angular/common';
import { DestroyRef, Signal, inject, signal } from '@angular/core';

/** Contagem regressiva legível: `0:42`, `12:05` e, de uma hora em diante, `1:02:03`. */
export function formatCountdown(totalSeconds: number): string {
  const total = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** A mesma espera em palavras, para quem usa leitor de tela (que não deve ouvir o contador andar). */
export function describeWait(totalSeconds: number): string {
  const total = Math.max(1, Math.ceil(totalSeconds));
  if (total < 60) {
    return total === 1
      ? $localize`:@@auth.wait.second:1 segundo`
      : $localize`:@@auth.wait.seconds:${total}:count: segundos`;
  }
  if (total < 3600) {
    const minutes = Math.ceil(total / 60);
    return minutes === 1
      ? $localize`:@@auth.wait.minute:1 minuto`
      : $localize`:@@auth.wait.minutes:${minutes}:count: minutos`;
  }
  const hours = Math.ceil(total / 3600);
  return hours === 1
    ? $localize`:@@auth.wait.hour:1 hora`
    : $localize`:@@auth.wait.hours:${hours}:count: horas`;
}

/** Contagem regressiva em segundos inteiros; `start` recomeça e `stop` zera. */
export interface Countdown {
  readonly remaining: Signal<number>;
  start(seconds: number): void;
  stop(): void;
}

/** Ritmo de conferência: pequeno para o número trocar perto da virada do segundo, sem custo (o sinal só muda quando o valor muda). */
const TICK_MS = 250;

/**
 * Cria uma contagem regressiva ancorada em um prazo (`Date.now() + espera`), e não em "menos um por segundo":
 * navegador de celular pausa os temporizadores com a página em segundo plano, e o número só estaria certo se
 * fosse recalculado ao voltar. Chame dentro de um contexto de injeção; tudo é desligado quando o dono é destruído.
 */
export function createCountdown(): Countdown {
  const doc = inject(DOCUMENT);
  const remaining = signal(0);
  let deadline = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    remaining.set(left);
    if (left === 0) stop();
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const onVisible = () => {
    if (timer !== undefined && doc.visibilityState === 'visible') tick();
  };

  doc.addEventListener('visibilitychange', onVisible);
  inject(DestroyRef).onDestroy(() => {
    stop();
    doc.removeEventListener('visibilitychange', onVisible);
  });

  return {
    remaining: remaining.asReadonly(),
    start(seconds: number) {
      stop();
      const wait = Math.max(0, Math.ceil(seconds));
      remaining.set(wait);
      if (wait === 0) return;
      deadline = Date.now() + wait * 1000;
      timer = setInterval(tick, TICK_MS);
    },
    stop() {
      stop();
      remaining.set(0);
    },
  };
}
