/**
 * `BroadcastChannel` falso para os testes: entrega a mensagem aos outros objetos do mesmo nome (como o de verdade, mas sem
 * esperar o laço de eventos), para simular duas abas no mesmo teste.
 */
export class FakeBroadcastChannel {
  private static readonly open = new Set<FakeBroadcastChannel>();

  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(readonly name: string) {
    FakeBroadcastChannel.open.add(this);
  }

  postMessage(data: unknown): void {
    for (const other of FakeBroadcastChannel.open) {
      if (other !== this && other.name === this.name) {
        queueMicrotask(() => other.onmessage?.({ data }));
      }
    }
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.open.delete(this);
  }

  /** Quantos canais estão abertos agora (para conferir que nenhum ficou vazando). */
  static openCount(): number {
    return FakeBroadcastChannel.open.size;
  }
}

/** Troca o `BroadcastChannel` da janela pelo falso; devolve a função que restaura o de antes. */
export function installFakeBroadcastChannel(): () => void {
  const before = Object.getOwnPropertyDescriptor(window, 'BroadcastChannel');
  Object.defineProperty(window, 'BroadcastChannel', {
    value: FakeBroadcastChannel,
    configurable: true,
  });
  return () => {
    if (before) Object.defineProperty(window, 'BroadcastChannel', before);
    else Reflect.deleteProperty(window, 'BroadcastChannel');
  };
}
