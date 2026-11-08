import type { Page } from '@playwright/test';

/** O que o PC de mentira recebeu pelo canal direto, por canal. */
export interface RtcLog {
  pointer: Record<string, unknown>[];
  input: Record<string, unknown>[];
  /** Quantas conexões WebRTC o app abriu. */
  connections: number;
}

/**
 * Troca o WebRTC do navegador por um par de mentira que faz o papel do agente: aceita o token (`ready`), responde cada
 * comando (`ack`) e cada sinal de vida (`pong`), e guarda tudo o que o app mandou. Nada sai do navegador, nada toca um PC.
 * `remove` apaga o `RTCPeerConnection` (um navegador sem WebRTC).
 */
export async function installFakeRtc(
  page: Page,
  options: { remove?: boolean } = {},
): Promise<void> {
  await page.addInitScript((remove: boolean) => {
    const w = window as unknown as Record<string, unknown>;
    if (remove) {
      delete w['RTCPeerConnection'];
      return;
    }
    const log = { pointer: [] as unknown[], input: [] as unknown[], connections: 0 };
    w['__rtc'] = log;
    const connections: FakeConnection[] = [];
    // A rede some: o canal cai e as tentativas seguintes (o app tenta de novo depois de um recuo) também falham.
    w['__rtcDrop'] = () => {
      w['__rtcBroken'] = true;
      for (const connection of connections) connection.fail();
    };

    class FakeChannel extends EventTarget {
      readyState = 'connecting';
      bufferedAmount = 0;
      constructor(readonly label: 'pointer' | 'input') {
        super();
      }
      reply(message: unknown) {
        setTimeout(() => {
          if (this.readyState === 'open') {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
          }
        }, 0);
      }
      send(text: string) {
        const message = JSON.parse(text) as Record<string, unknown>;
        (log[this.label] as unknown[]).push(message);
        if (this.label === 'input' && message['k'] === 'auth') this.reply({ k: 'ready' });
        if (this.label === 'input' && message['k'] === 'cmd') {
          this.reply({ k: 'ack', i: message['i'], ok: true });
        }
        if (this.label === 'pointer' && message['k'] === 'ping') {
          this.reply({ k: 'pong', n: message['n'] });
        }
      }
      close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
      }
      open() {
        this.readyState = 'open';
        this.dispatchEvent(new Event('open'));
      }
    }

    class FakeConnection extends EventTarget {
      iceGatheringState = 'complete';
      connectionState = 'new';
      localDescription: { type: string; sdp: string } | null = null;
      channels: FakeChannel[] = [];
      constructor() {
        super();
        log.connections++;
        connections.push(this);
      }
      createDataChannel(label: 'pointer' | 'input') {
        const channel = new FakeChannel(label);
        this.channels.push(channel);
        return channel;
      }
      createOffer() {
        if (w['__rtcBroken']) return Promise.reject(new Error('rede perdida'));
        return Promise.resolve({
          type: 'offer',
          sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA',
        });
      }
      setLocalDescription(description: { type: string; sdp: string }) {
        this.localDescription = description;
        return Promise.resolve();
      }
      setRemoteDescription() {
        setTimeout(() => {
          this.connectionState = 'connected';
          for (const channel of this.channels) channel.open();
        }, 0);
        return Promise.resolve();
      }
      fail() {
        this.connectionState = 'failed';
        this.dispatchEvent(new Event('connectionstatechange'));
      }
      close() {
        this.connectionState = 'closed';
        for (const channel of this.channels) channel.close();
      }
    }
    w['RTCPeerConnection'] = FakeConnection;
  }, options.remove === true);
}

export function rtcLog(page: Page): Promise<RtcLog | null> {
  return page.evaluate(() => (window as unknown as { __rtc?: RtcLog }).__rtc ?? null);
}

/** O canal cai de repente (rede perdida): o estado do par vira "falhou". */
export async function dropRtc(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __rtcDrop: () => void }).__rtcDrop());
}
