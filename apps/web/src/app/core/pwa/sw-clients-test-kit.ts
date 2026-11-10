/** `MessageChannel` mínimo para os testes: o que entra pela `port2` chega em `port1.onmessage` (como o de verdade). */
export class FakeMessageChannel {
  readonly port1: {
    onmessage: ((event: { data: unknown }) => void) | null;
    close: () => void;
  };
  readonly port2: { postMessage: (data: unknown) => void };

  constructor() {
    const port1 = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      close: () => undefined,
    };
    this.port1 = port1;
    this.port2 = { postMessage: (data) => queueMicrotask(() => port1.onmessage?.({ data })) };
  }
}

/** Troca o `MessageChannel` da janela pelo falso; devolve a função que o tira. */
export function installFakeMessageChannel(): () => void {
  Object.defineProperty(window, 'MessageChannel', {
    value: FakeMessageChannel,
    configurable: true,
  });
  return () => Reflect.deleteProperty(window, 'MessageChannel');
}
