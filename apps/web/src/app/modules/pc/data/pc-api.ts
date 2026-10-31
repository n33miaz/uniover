import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../../core/config/app-config';
import type { PcClickButton, PcKey, PcMediaAction, PcModifier, PcPowerAction } from './pc-types';

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

  async pointer(dx: number, dy: number, scrollX = 0, scrollY = 0): Promise<void> {
    const body: Record<string, number> = { dx, dy };
    if (scrollX !== 0) body['scrollX'] = scrollX;
    if (scrollY !== 0) body['scrollY'] = scrollY;
    await firstValueFrom(this.http.post(`${BASE}/pointer`, body));
  }

  async click(button: PcClickButton, action?: 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP'): Promise<void> {
    await firstValueFrom(this.http.post(`${BASE}/click`, action ? { button, action } : { button }));
  }

  async key(key: PcKey, modifiers: readonly PcModifier[] = []): Promise<void> {
    await firstValueFrom(
      this.http.post(`${BASE}/key`, modifiers.length ? { key, modifiers } : { key }),
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
