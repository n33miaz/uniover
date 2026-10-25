import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../core/api/generated/schema';
import { APP_CONFIG } from '../../core/config/app-config';

/** Aparelho pareado, como a API lista (tipo gerado do OpenAPI). */
export type DeviceAgent = components['schemas']['AgentSummary'];

/** O fim do registro de um agente, já sem segredos (o agente os remove antes de enviar). */
export interface AgentLog {
  readonly text: string;
  readonly lines: number;
  /** O agente cortou as linhas mais antigas para caber no limite do canal. */
  readonly truncated: boolean;
  readonly at: string;
}

/**
 * O que se pode pedir ao agente: `update` (atualizar agora), `restart` (reiniciar o agente) ou `rollback` (voltar para a
 * versão anterior que a última atualização guardou).
 */
export type MaintenanceAction = 'update' | 'restart' | 'rollback';

/** Quantas linhas do registro a tela pede. */
export const LOG_LINES = 300;

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

  /** Aprova o código e cria a TV já ligada ao computador. Exige a mesma confirmação com passkey usada ao criar uma TV. */
  async approve(
    userCode: string,
    name: string | null,
    tvName: string | null,
    tvMemberIds: readonly string[],
  ): Promise<void> {
    const body: components['schemas']['ApprovePairingRequest'] = {
      userCode,
      name,
      tvName,
      tvMemberIds: [...tvMemberIds],
    };
    await firstValueFrom(this.http.post(`${BASE}/pairing/approve`, body));
  }

  /**
   * O convidado com a TV aprova o pareamento do PC dele para a PRÓPRIA TV: a TV nasce só com ele (nunca a padrão), com
   * o nome dado (ou o do PC). Exige a senha reconfirmada pouco antes (ver `AuthApi.stepUpWithPassword`).
   */
  async approveOwn(userCode: string, tvName: string | null): Promise<void> {
    const body: components['schemas']['ApproveOwnPairingRequest'] = {
      userCode,
      name: null,
      tvName,
    };
    await firstValueFrom(this.http.post(`${BASE}/pairing/approve-own`, body));
  }

  async deny(userCode: string): Promise<void> {
    const body: components['schemas']['DenyPairingRequest'] = { userCode };
    await firstValueFrom(this.http.post(`${BASE}/pairing/deny`, body));
  }

  /** O fim do registro do agente (só o administrador). Falhas vêm como problema da API: `agent-outdated`, `agent-offline`... */
  async logs(id: string, lines = LOG_LINES): Promise<AgentLog> {
    const body: components['schemas']['AgentLogsRequest'] = { lines };
    const response = await firstValueFrom(
      this.http.post<components['schemas']['AgentLogsResponse']>(
        `${BASE}/agents/${encodeURIComponent(id)}/logs`,
        body,
      ),
    );
    return {
      text: response.text,
      lines: Number(response.lines),
      truncated: response.truncated,
      at: response.at,
    };
  }

  /**
   * Atualiza ou reinicia o agente. Pede a passkey (o interceptador abre o diálogo e repete o pedido); a API só
   * responde depois que o agente entregou o pedido ao supervisor do PC.
   */
  async maintain(id: string, action: MaintenanceAction): Promise<void> {
    const body: components['schemas']['AgentMaintenanceRequest'] = { action };
    await firstValueFrom(
      this.http.post(`${BASE}/agents/${encodeURIComponent(id)}/maintenance`, body),
    );
  }

  /** Ação protetora: sem passkey, e repetir é inofensivo. */
  async revoke(id: string): Promise<void> {
    const body: components['schemas']['RevokeAgentRequest'] = { reason: null };
    await firstValueFrom(this.http.post(`${BASE}/agents/${encodeURIComponent(id)}/revoke`, body));
  }
}
