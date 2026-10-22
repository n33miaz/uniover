import { InjectionToken } from '@angular/core';

/**
 * Folga (ms) entre uma conta sair de cena e o banco dela ser fechado. Quem estava lendo o banco quando a conta mudou (uma
 * tela já destruída com uma leitura em andamento, uma gravação que acabou de começar) termina o que começou: fechar no
 * mesmo instante transformaria cada passo seguinte dessas leituras numa rejeição solta (`DatabaseClosedError`) no console,
 * sem ninguém para tratá-la. Passada a folga o banco fecha de verdade; nenhuma conta nova o usa nesse intervalo.
 */
export const DB_CLOSE_GRACE_MS = new InjectionToken<number>('DB_CLOSE_GRACE_MS', {
  providedIn: 'root',
  factory: () => 2000,
});

/** Espera a folga (nada, se for zero). */
export function waitGrace(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
