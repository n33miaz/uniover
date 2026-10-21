import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../../core/api/generated/schema';
import { APP_CONFIG } from '../../../core/config/app-config';
import {
  TvCleanupResult,
  TvKey,
  TvShortcut,
  TvState,
  normalizeShortcut,
  parseShortcuts,
  parseState,
} from './tv-types';

const BASE = `${APP_CONFIG.apiBase}/v1/tv`;

/** Caminho do fluxo de eventos (o cookie de bilhete do `StreamService` é a credencial, nunca um token na URL). */
export const TV_EVENTS_PATH = `${BASE}/events`;

/**
 * Cliente da API da TV. Usa o `HttpClient` do app (os interceptadores levam o Bearer e renovam a sessão); o
 * cliente é buscado só na hora da chamada, para a tela abrir mesmo onde ele não foi provido (nos testes de rota).
 * Teclas e comandos não passam pela fila offline: controle é em tempo real, e um comando velho executado depois
 * seria pior do que nenhum.
 */
@Injectable({ providedIn: 'root' })
export class TvApi {
  private readonly injector = inject(Injector);

  private get http(): HttpClient {
    return this.injector.get(HttpClient);
  }

  async state(): Promise<TvState> {
    const dto = await firstValueFrom(
      this.http.get<components['schemas']['TvState']>(`${BASE}/state`),
    );
    const state = parseState(dto);
    if (!state) throw new Error('Estado da TV em formato inesperado.');
    return state;
  }

  async shortcuts(): Promise<TvShortcut[]> {
    const dto = await firstValueFrom(this.http.get<TvShortcut[]>(`${BASE}/shortcuts`));
    return parseShortcuts(dto) ?? [];
  }

  /** Pré-aquece a sessão com a TV; o servidor responde 202 sem esperar o agente. */
  async wake(): Promise<void> {
    await firstValueFrom(this.http.post(`${BASE}/wake`, null));
  }

  /** `POWER` nunca passa aqui (a API responde 400): desligar é {@link powerOff}. */
  async sendKey(key: TvKey): Promise<void> {
    const body: components['schemas']['SendKeyRequest'] = { key, direction: null };
    await firstValueFrom(this.http.post(`${BASE}/keys`, body));
  }

  async sendText(text: string): Promise<void> {
    const body: components['schemas']['SendTextRequest'] = { text };
    await firstValueFrom(this.http.post(`${BASE}/text`, body));
  }

  /** Sem passkey (decisão do dono): o freio é o limite de comandos e a trilha de auditoria da API. */
  async powerOff(): Promise<void> {
    await firstValueFrom(this.http.post(`${BASE}/power/off`, null));
  }

  /**
   * Fecha os apps abertos na TV e libera memória, sem derrubar o controle. Leva alguns segundos (o servidor espera o
   * agente por até 30 s), e devolve o que o agente relatou.
   */
  async cleanup(): Promise<TvCleanupResult> {
    return firstValueFrom(this.http.post<TvCleanupResult>(`${BASE}/cleanup`, null));
  }

  async launch(id: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${BASE}/shortcuts/${encodeURIComponent(id)}/launch`, null),
    );
  }

  async refreshShortcuts(): Promise<void> {
    await firstValueFrom(this.http.post(`${BASE}/shortcuts/refresh`, null));
  }

  /** Muda só o que vier preenchido (`null` = não muda); texto vazio em `customLabel` apaga o nome próprio. */
  async updateShortcut(
    id: string,
    change: { customLabel?: string; enabled?: boolean },
  ): Promise<TvShortcut> {
    const body: components['schemas']['UpdateShortcutRequest'] = {
      customLabel: change.customLabel ?? null,
      enabled: change.enabled ?? null,
    };
    const updated = await firstValueFrom(
      this.http.patch<TvShortcut>(`${BASE}/shortcuts/${encodeURIComponent(id)}`, body),
    );
    return normalizeShortcut(updated);
  }

  /**
   * Grava a ordem dos atalhos (só o dono). `ids` é a lista COMPLETA, na ordem desejada: a API recusa (400) tudo que
   * não for uma permutação exata dos atalhos que ela tem. Devolve a lista como ficou, já renumerada.
   */
  async reorderShortcuts(ids: readonly string[]): Promise<TvShortcut[]> {
    const body: components['schemas']['ReorderShortcutsRequest'] = { ids: [...ids] };
    const dto = await firstValueFrom(this.http.put<TvShortcut[]>(`${BASE}/shortcuts/order`, body));
    const list = parseShortcuts(dto);
    if (!list) throw new Error('Lista de atalhos em formato inesperado.');
    return list;
  }
}
