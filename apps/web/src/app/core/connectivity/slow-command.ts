import {
  DestroyRef,
  Injectable,
  InjectionToken,
  Injector,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ClientTelemetry } from '../telemetry/client-telemetry';
import { ResumeGrace } from './resume-grace';

/** Os módulos que mandam comandos e podem ficar sem resposta. */
export type CommandModule = 'tv' | 'pc' | 'training';

/** `normal`: o toque que responde em instantes · `long`: a ação que demora de propósito (limpar e desligar a TV esperam o agente confirmar). */
export type SlowCommandKind = 'normal' | 'long';

export interface SlowCommandConfig {
  /** Quanto um comando pode ficar sem resposta antes de o aviso aparecer, por módulo. */
  readonly thresholdMs: Readonly<Record<CommandModule, number>>;
  /** O mesmo prazo para as ações que demoram de propósito: elas também ganham aviso, só que mais tarde. */
  readonly longThresholdMs: Readonly<Record<CommandModule, number>>;
}

export const SLOW_COMMAND_CONFIG = new InjectionToken<SlowCommandConfig>('SLOW_COMMAND_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    thresholdMs: { tv: 3_000, pc: 3_000, training: 3_000 },
    // A limpeza da TV leva até ~25 s e o desligamento com leitura espera a TV confirmar: o aviso vem só passado esse tempo.
    longThresholdMs: { tv: 30_000, pc: 30_000, training: 30_000 },
  }),
});

interface Pending {
  readonly module: CommandModule;
  readonly thresholdMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  cancelWait: (() => void) | undefined;
  shown: boolean;
}

/**
 * "Parecia funcionar, mas não foi": o comando que a pessoa deu e que fica sem resposta além de um prazo curto ganha um aviso
 * discreto e honesto ("A TV não está respondendo"), que some sozinho quando a resposta chega (ou quando falha: a falha tem o
 * texto dela). Nunca silêncio quando o comando não chegou, e nunca aviso na carência da volta ao app (`ResumeGrace`): se o
 * comando ainda espera quando ela acaba, o aviso sai nesse instante. O prazo é por módulo (`SLOW_COMMAND_CONFIG`).
 *
 * Uso: `const done = watch.begin('tv'); try { await comando; } finally { done(); }`, ou `watch.track('tv', promessa)`.
 */
@Injectable({ providedIn: 'root' })
export class SlowCommandWatch {
  private readonly config = inject(SLOW_COMMAND_CONFIG);
  private readonly grace = inject(ResumeGrace);
  private readonly injector = inject(Injector);
  private readonly pending = new Set<Pending>();
  private readonly slowCount = signal<Readonly<Record<CommandModule, number>>>({
    tv: 0,
    pc: 0,
    training: 0,
  });

  /** Os módulos com comando lento agora (para quem quer a lista inteira). */
  readonly slowModules = computed(() => {
    const counts = this.slowCount();
    return (Object.keys(counts) as CommandModule[]).filter((module) => counts[module] > 0);
  });

  constructor() {
    // O serviço some (a aba fecha, o teste acaba): nenhum temporizador de comando pendente sobrevive a ele.
    inject(DestroyRef).onDestroy(() => {
      for (const entry of this.pending) {
        clearTimeout(entry.timer);
        entry.cancelWait?.();
      }
      this.pending.clear();
    });
  }

  /** Há comando do módulo sem resposta além do prazo. Lê um sinal: serve em `computed` e em template. */
  isSlow(module: CommandModule): boolean {
    return this.slowCount()[module] > 0;
  }

  /** Começa a vigiar um comando; devolve o que encerra (chamar na resposta, de sucesso ou de falha). Chamar de novo não faz nada. */
  begin(module: CommandModule, kind: SlowCommandKind = 'normal'): () => void {
    const thresholdMs =
      kind === 'long' ? this.config.longThresholdMs[module] : this.config.thresholdMs[module];
    const entry: Pending = {
      module,
      thresholdMs,
      timer: undefined,
      cancelWait: undefined,
      shown: false,
    };
    this.pending.add(entry);
    entry.timer = setTimeout(() => this.expire(entry), thresholdMs);
    return () => this.end(entry);
  }

  /** Vigia `work` do início ao fim e o devolve inalterado. */
  async track<T>(module: CommandModule, work: Promise<T>): Promise<T> {
    const done = this.begin(module);
    try {
      return await work;
    } finally {
      done();
    }
  }

  private expire(entry: Pending): void {
    entry.timer = undefined;
    if (!this.pending.has(entry)) return;
    // Na carência da volta ao app o silêncio vale; passada ela, o comando que ainda espera é avisado.
    entry.cancelWait = this.grace.afterEnd(() => {
      entry.cancelWait = undefined;
      if (!this.pending.has(entry)) return;
      entry.shown = true;
      this.bump(entry.module, 1);
      this.report(entry);
    });
  }

  private end(entry: Pending): void {
    if (!this.pending.delete(entry)) return;
    clearTimeout(entry.timer);
    entry.cancelWait?.();
    if (entry.shown) this.bump(entry.module, -1);
  }

  private bump(module: CommandModule, delta: number): void {
    this.slowCount.update((counts) => ({
      ...counts,
      [module]: Math.max(0, counts[module] + delta),
    }));
  }

  /** Deixa o registro (só o módulo e o prazo, sem nada do comando) para o dono consultar depois. */
  private report(entry: Pending): void {
    this.injector.get(ClientTelemetry).record({
      kind: 'command-slow',
      module: entry.module,
      code: `over_${Math.round(entry.thresholdMs / 1_000)}s`,
    });
  }
}
