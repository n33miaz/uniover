import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

/** O mínimo que se usa do `AudioContext` (o Safari antigo o expõe como `webkitAudioContext`). */
interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  resume?(): Promise<void>;
  createOscillator(): {
    frequency: { value: number };
    connect(destination: unknown): void;
    start(when?: number): void;
    stop(when?: number): void;
  };
}

type AudioContextConstructor = new () => AudioContextLike;

/** Padrão de vibração do fim do descanso: toque, pausa, toque. */
export const REST_VIBRATION: readonly number[] = [200, 100, 200];

/**
 * Aviso do fim do descanso: vibração quando o aparelho a tem e um bipe curto **se** o áudio já foi liberado por um
 * toque do usuário (a tela chama `unlock()` no "Iniciar treino"). O iPhone não tem `navigator.vibrate`, e sem o toque
 * prévio o navegador recusa o áudio: tudo aqui é melhor esforço e nunca lança.
 */
@Injectable()
export class RestAlert {
  private readonly win = inject(DOCUMENT).defaultView;
  private context: AudioContextLike | null = null;

  /** O áudio foi liberado por um toque? */
  get unlocked(): boolean {
    return this.context !== null;
  }

  /** Libera o áudio. Chamar de dentro de um gesto do usuário (o toque em "Iniciar treino"). */
  unlock(): void {
    try {
      const win = this.win as
        | (Window & {
            AudioContext?: AudioContextConstructor;
            webkitAudioContext?: AudioContextConstructor;
          })
        | null;
      const Context = win?.AudioContext ?? win?.webkitAudioContext;
      if (Context === undefined) return;
      this.context ??= new Context();
      void this.context.resume?.().catch(() => undefined);
    } catch {
      this.context = null;
    }
  }

  /** Avisa que o descanso acabou: vibra se der e apita se o áudio foi liberado. */
  fire(): void {
    try {
      this.win?.navigator.vibrate?.([...REST_VIBRATION]);
    } catch {
      // Sem vibração (ou recusada): segue sem ela.
    }
    this.beep();
  }

  private beep(): void {
    const context = this.context;
    if (context === null) return;
    try {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 880;
      oscillator.connect(context.destination);
      oscillator.start(context.currentTime);
      oscillator.stop(context.currentTime + 0.25);
    } catch {
      // O navegador pode recusar o som; o descanso acabar não depende dele.
    }
  }
}
