import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../core/api/generated/schema';
import { APP_CONFIG } from '../../core/config/app-config';

/** Aparelho pareado, como a API lista (tipo gerado do OpenAPI). */
export type DeviceAgent = components['schemas']['AgentSummary'];

const BASE = `${APP_CONFIG.apiBase}/v1/devices`;

/**
 * Cliente da API de aparelhos. Usa o `HttpClient`, cujos interceptadores já levam o Bearer, renovam a sessão e,
 * no 403 de confirmação pendente, abrem a passkey e repetem o pedido uma única vez; por isso nada aqui trata isso.
 */
@Injectable({ providedIn: 'root' })
export class DevicesApi {
  private readonly http = inject(HttpClient);

  list(): Promise<readonly DeviceAgent[]> {
    return firstValueFrom(this.http.get<DeviceAgent[]>(`${BASE}/agents`));
  }

  /** Aprova o código mostrado no aparelho. Exige a confirmação com a passkey. `name` nulo mantém o nome do agente. */
  async approve(userCode: string, name: string | null): Promise<void> {
    const body: components['schemas']['ApprovePairingRequest'] = { userCode, name };
    await firstValueFrom(this.http.post(`${BASE}/pairing/approve`, body));
  }

  async deny(userCode: string): Promise<void> {
    const body: components['schemas']['DenyPairingRequest'] = { userCode };
    await firstValueFrom(this.http.post(`${BASE}/pairing/deny`, body));
  }

  /** Ação protetora: sem passkey, e repetir é inofensivo. */
  async revoke(id: string): Promise<void> {
    const body: components['schemas']['RevokeAgentRequest'] = { reason: null };
    await firstValueFrom(this.http.post(`${BASE}/agents/${encodeURIComponent(id)}/revoke`, body));
  }
}
