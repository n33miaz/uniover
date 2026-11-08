import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../../core/config/app-config';
import {
  clampKeyRepeat,
  type PcClickButton,
  type PcHoldableKey,
  type PcKey,
  type PcKeyOptions,
  type PcMediaAction,
  type PcModifier,
  type PcPowerAction,
} from './pc-types';

const BASE = `${APP_CONFIG.apiBase}/v1/pc`;

/**
 * Cliente da API do controle do PC. Usa o `HttpClient` do app (os interceptadores levam o Bearer e renovam a sessão); é
 * buscado só na hora da chamada. Nenhum comando passa pela fila offline: controle é em tempo real, e um movimento ou uma
 * tecla executados depois seriam piores que nenhum. Toda chamada responde 204 quando o PC executou.
 */
@Injectable({ providedIn: 'root' })
export class PcApi {
  private readonly injector = inject(Injector);

  private get http(): HttpClient {
    return this.injector.get(HttpClient);
  }

  /**
   * `seq` numera os pedidos de movimento (crescente): vários saem ao mesmo tempo e o agente usa o número para reconhecer
   * o que chega fora de ordem (diagnóstico; o movimento é relativo e todos são aplicados). O sinal de vida não leva.
   */
  async pointer(dx: number, dy: number, scrollX = 0, scrollY = 0, seq?: number): Promise<void> {
    const body: Record<string, number> = { dx, dy };
    if (scrollX !== 0) body['scrollX'] = scrollX;
    if (scrollY !== 0) body['scrollY'] = scrollY;
    if (seq !== undefined) body['seq'] = seq;
    await firstValueFrom(this.http.post(`${BASE}/pointer`, body));
  }

  /**
   * `keepalive` deixa o navegador terminar o pedido mesmo com a página fechando (é o que solta o botão apertado em
   * `pagehide`). Só tem efeito com o `fetch`, que é o que o app usa; sem ele o pedido segue como qualquer outro.
   */
  async click(
    button: PcClickButton,
    action?: 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP',
    options: { readonly keepalive?: boolean } = {},
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(
        `${BASE}/click`,
        action ? { button, action } : { button },
        options.keepalive ? { keepalive: true } : {},
      ),
    );
  }

  /**
   * O corpo só leva `repeat` e `action` quando mudam alguma coisa: um toque comum sai igual ao de sempre, e a API manda a v1
   * ao agente. `repeat` e `action` são da `pc.key.v2`; com um agente anterior a ela a API responde 409 `pc-key-unsupported`.
   */
  async key(
    key: PcKey,
    modifiers: readonly PcModifier[] = [],
    options: PcKeyOptions = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { key };
    if (modifiers.length) body['modifiers'] = modifiers;
    const repeat = clampKeyRepeat(options.repeat);
    if (repeat > 1) body['repeat'] = repeat;
    if (options.action !== undefined && options.action !== 'PRESS') body['action'] = options.action;
    await firstValueFrom(this.http.post(`${BASE}/key`, body));
  }

  /**
   * Solta um modificador que o app segurou (`DOWN`). Rota própria, com limite próprio: a soltura nunca espera na fila dos
   * apertos nem é recusada por eles. `keepalive` deixa o navegador terminar o pedido mesmo com a página fechando.
   */
  async keyRelease(
    key: PcHoldableKey,
    options: { readonly keepalive?: boolean } = {},
  ): Promise<void> {
    await firstValueFrom(
      this.http.post(`${BASE}/key/release`, { key }, options.keepalive ? { keepalive: true } : {}),
    );
  }

  async text(text: string): Promise<void> {
    await firstValueFrom(this.http.post(`${BASE}/text`, { text }));
  }

  async media(action: PcMediaAction, steps = 1): Promise<void> {
    await firstValueFrom(
      this.http.post(`${BASE}/media`, steps > 1 ? { action, steps } : { action }),
    );
  }

  /** Suspender e desligar só valem com `confirm: true`: a API recusa sem ele. */
  async power(action: PcPowerAction, confirm = false): Promise<void> {
    await firstValueFrom(
      this.http.post(`${BASE}/power`, confirm ? { action, confirm } : { action }),
    );
  }

  async launch(appId: string): Promise<void> {
    await firstValueFrom(this.http.post(`${BASE}/apps/${encodeURIComponent(appId)}/launch`, null));
  }
}
