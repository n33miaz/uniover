import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, inject } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import { APP_CONFIG } from '../../../core/config/app-config';
import { PcDirect, DirectNotSent, type DirectCommandType } from './pc-direct';
import {
  PC_TEXT_MAX_ERASE,
  clampClickGap,
  clampKeyRepeat,
  clampVolumeLevel,
  clampZoomSteps,
  clickNeedsV2,
  keyNeedsV2,
  textEditNeedsV2,
  type PcClickButton,
  type PcClickOptions,
  type PcHoldableKey,
  type PcKey,
  type PcKeyOptions,
  type PcMediaAction,
  type PcModifier,
  type PcPowerAction,
  type PcTextEdit,
  type PcVolumeChange,
} from './pc-types';

const BASE = `${APP_CONFIG.apiBase}/v1/pc`;

/**
 * Cliente da API do controle do PC. Usa o `HttpClient` do app (os interceptadores levam o Bearer e renovam a sessão); é
 * buscado só na hora da chamada. Nenhum comando passa pela fila offline: controle é em tempo real, e um movimento ou uma
 * tecla executados depois seriam piores que nenhum. Toda chamada responde 204 quando o PC executou.
 *
 * Os comandos de entrada (movimento, clique, tecla, texto, mídia) saem pelo canal direto (`PcDirect`) quando ele está
 * aberto e a nuvem não tem nada em voo; senão, e sempre que o canal não puder levar o comando, saem pela API como sempre.
 * O que já saiu no canal e não foi respondido nunca é reenviado pela nuvem (o resultado é incerto, como o `504` dela).
 * Energia e favoritos só existem pela nuvem. Quem chama não sabe por onde o comando foi.
 */
@Injectable({ providedIn: 'root' })
export class PcApi {
  private readonly injector = inject(Injector);
  private readonly direct = inject(PcDirect);

  private get http(): HttpClient {
    return this.injector.get(HttpClient);
  }

  /**
   * Cada pedido de clique, tecla, texto e mídia pela nuvem leva um `seq` de um contador só (ver `PcDirect.nextCloudSeq`): é o
   * marcador que o canal direto declara ao agente na troca de caminho.
   *
   * `seq` (do movimento) numera os pedidos de movimento (crescente): vários saem ao mesmo tempo e o agente usa o número para reconhecer
   * o que chega fora de ordem (diagnóstico; o movimento é relativo e todos são aplicados). O sinal de vida não leva.
   */
  async pointer(dx: number, dy: number, scrollX = 0, scrollY = 0, seq?: number): Promise<void> {
    if (this.direct.canUse()) {
      try {
        // O canal leva o TOTAL acumulado: a resposta é imediata (não há o que esperar) e a mensagem perdida se cobre sozinha.
        this.direct.sendPointer(dx, dy, scrollX, scrollY);
        return;
      } catch (error) {
        if (!(error instanceof DirectNotSent)) throw error;
      }
    }
    const body: Record<string, number> = { dx, dy };
    if (scrollX !== 0) body['scrollX'] = scrollX;
    if (scrollY !== 0) body['scrollY'] = scrollY;
    if (seq !== undefined) body['seq'] = seq;
    await this.cloud(this.http.post(`${BASE}/pointer`, body));
  }

  /**
   * `keepalive` deixa o navegador terminar o pedido mesmo com a página fechando (é o que solta o botão apertado em
   * `pagehide`). Só tem efeito com o `fetch`, que é o que o app usa; sem ele o pedido segue como qualquer outro.
   *
   * `modifiers` e `gapMs` são da `pc.click.v2` (só para `CLICK` e `DOUBLE`): o corpo só os leva quando valem alguma coisa, e quem
   * chama só os passa a um PC que declarou `pc.click.v2` (nem o canal direto nem a nuvem entendem a v2 num agente anterior).
   */
  async click(
    button: PcClickButton,
    action?: 'CLICK' | 'DOUBLE' | 'DOWN' | 'UP',
    options: { readonly keepalive?: boolean } & PcClickOptions = {},
  ): Promise<void> {
    const body: Record<string, unknown> = action ? { button, action } : { button };
    if (options.modifiers?.length) body['modifiers'] = options.modifiers;
    const gapMs = clampClickGap(options.gapMs);
    if (gapMs > 0) body['gapMs'] = gapMs;
    const type = clickNeedsV2(options) ? 'pc.click.v2' : 'pc.click.v1';
    // O `keepalive` é da página que está morrendo: só a nuvem termina um pedido depois dela.
    if (!options.keepalive && this.direct.canUse() && (await this.viaDirect(type, body))) return;
    await this.cloud(
      this.http.post(
        `${BASE}/click`,
        { ...body, ...this.numbered() },
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
    // No canal o agente entende a v2 sempre; a v1 só quando o pedido cabe nela (como a API faz).
    if (
      this.direct.canUse() &&
      (await this.viaDirect(keyNeedsV2(key, options) ? 'pc.key.v2' : 'pc.key.v1', body))
    )
      return;
    await this.cloud(this.http.post(`${BASE}/key`, { ...body, ...this.numbered() }));
  }

  /**
   * Solta um modificador que o app segurou (`DOWN`). Rota própria, com limite próprio: a soltura nunca espera na fila dos
   * apertos nem é recusada por eles. `keepalive` deixa o navegador terminar o pedido mesmo com a página fechando.
   */
  async keyRelease(
    key: PcHoldableKey,
    options: { readonly keepalive?: boolean } = {},
  ): Promise<void> {
    if (
      !options.keepalive &&
      this.direct.canUse() &&
      (await this.viaDirect('pc.key.v2', { key, action: 'UP' }))
    )
      return;
    await this.cloud(
      this.http.post(
        `${BASE}/key/release`,
        { key, ...this.numbered() },
        options.keepalive ? { keepalive: true } : {},
      ),
    );
  }

  async text(text: string): Promise<void> {
    if (this.direct.canUse() && (await this.viaDirect('pc.text.v1', { text }))) return;
    await this.cloud(this.http.post(`${BASE}/text`, { text, ...this.numbered() }));
  }

  /**
   * Uma edição do campo (apagar, digitar e apertar uma tecla) num pedido só. O corpo só leva o que há: apagar e a tecla do fim
   * são da `pc.text.v2` (quem chama só a usa com um PC que declarou `pc.text.v2`); texto puro sai como sempre, pela v1.
   */
  async edit(edit: PcTextEdit): Promise<void> {
    const body: Record<string, unknown> = {};
    const erase = Math.max(0, Math.min(PC_TEXT_MAX_ERASE, Math.trunc(edit.erase ?? 0)));
    if (erase > 0) body['erase'] = erase;
    if (edit.text) body['text'] = edit.text;
    if (edit.key !== undefined) body['key'] = edit.key;
    const type = textEditNeedsV2({ ...edit, erase }) ? 'pc.text.v2' : 'pc.text.v1';
    if (this.direct.canUse() && (await this.viaDirect(type, body))) return;
    await this.cloud(this.http.post(`${BASE}/text`, { ...body, ...this.numbered() }));
  }

  async media(action: PcMediaAction, steps = 1): Promise<void> {
    const body = steps > 1 ? { action, steps } : { action };
    if (this.direct.canUse() && (await this.viaDirect('pc.media.v1', body))) return;
    await this.cloud(this.http.post(`${BASE}/media`, { ...body, ...this.numbered() }));
  }

  /**
   * O zoom da pinça: `steps` cliques de roda com o Ctrl apertado (positivo aproxima), de -12 a 12 e nunca zero. Mensagem nova, sem v1:
   * quem chama só a usa com um PC que declarou `pc.pointer.zoom.v1`. Sem passos (zero) nada sai.
   */
  async zoom(steps: number): Promise<void> {
    const clamped = clampZoomSteps(steps);
    if (clamped === 0) return;
    const body = { steps: clamped };
    if (this.direct.canUse() && (await this.viaDirect('pc.pointer.zoom.v1', body))) return;
    await this.cloud(this.http.post(`${BASE}/zoom`, { ...body, ...this.numbered() }));
  }

  /**
   * O volume absoluto: o nível (0 a 100) e/ou o mudo, sem alternar. Mensagem nova, sem v1: quem chama só a usa com um PC que declarou
   * `pc.volume.v1`. Um pedido sem nada a mudar não sai.
   */
  async volume(change: PcVolumeChange): Promise<void> {
    const body: Record<string, unknown> = {};
    if (change.level !== undefined) body['level'] = clampVolumeLevel(change.level);
    if (change.muted !== undefined) body['muted'] = change.muted;
    if (Object.keys(body).length === 0) return;
    if (this.direct.canUse() && (await this.viaDirect('pc.volume.v1', body))) return;
    await this.cloud(this.http.post(`${BASE}/volume`, { ...body, ...this.numbered() }));
  }

  /** Suspender e desligar só valem com `confirm: true`: a API recusa sem ele. */
  async power(action: PcPowerAction, confirm = false): Promise<void> {
    await this.cloud(this.http.post(`${BASE}/power`, confirm ? { action, confirm } : { action }));
  }

  async launch(appId: string): Promise<void> {
    await this.cloud(this.http.post(`${BASE}/apps/${encodeURIComponent(appId)}/launch`, null));
  }

  /**
   * Manda o comando pelo canal direto, se ele pode levá-lo agora: `true` se o PC o executou (a resposta do agente), `false`
   * se nada saiu e a nuvem deve levar. Falha de verdade (recusa do agente, resposta que não veio) sobe como erro, no
   * mesmo formato da nuvem.
   */
  private async viaDirect(
    type: DirectCommandType,
    body: Record<string, unknown>,
  ): Promise<boolean> {
    // Um agente que não listou a mensagem no `ready` do canal não a entende: a nuvem leva (a API manda a v1 ou recusa na borda).
    if (!this.direct.canUse() || !this.direct.accepts(type)) return false;
    try {
      await this.direct.command(type, body);
      return true;
    } catch (error) {
      if (error instanceof DirectNotSent) return false;
      throw error;
    }
  }

  /** O número do próximo pedido da nuvem e a época desta página: o agente só os compara juntos. */
  private numbered(): { seq: number; epoch: string } {
    return { seq: this.direct.nextCloudSeq(), epoch: this.direct.cloudEpoch };
  }

  /** O pedido da nuvem, contado como em voo: o canal só assume quando nenhum está no ar (nada passa na frente de nada). */
  private cloud(request: Observable<unknown>): Promise<unknown> {
    return this.direct.trackCloud(firstValueFrom(request));
  }
}
