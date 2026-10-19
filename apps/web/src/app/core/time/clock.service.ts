import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** Relógio em signal para a saudação e a hora da Início; atualiza a cada 30 s (basta para mostrar minutos). */
@Injectable({ providedIn: 'root' })
export class ClockService {
  readonly now = signal(new Date());

  constructor() {
    const timer = setInterval(() => this.now.set(new Date()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
