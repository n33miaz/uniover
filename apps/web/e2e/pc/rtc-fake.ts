import type { Page } from '@playwright/test';

/** O que o PC de mentira recebeu pelo canal direto, por canal. */
export interface RtcLog {
  pointer: Record<string, unknown>[];
  input: Record<string, unknown>[];
  screen?: Record<string, unknown>[];
  /** Quantas conexões WebRTC o app abriu. */
  connections: number;
}

/**
 * Troca o WebRTC do navegador por um par de mentira que faz o papel do agente: aceita o token (`ready`), responde cada
 * comando (`ack`) e cada sinal de vida (`pong`), e guarda tudo o que o app mandou. Nada sai do navegador, nada toca um PC.
 * `remove` apaga o `RTCPeerConnection` (um navegador sem WebRTC). `caps` é a lista de mensagens que o `ready` anuncia (sem ela,
 * só as de sempre).
 */
export async function installFakeRtc(
  page: Page,
  options: { remove?: boolean; caps?: readonly string[] } = {},
): Promise<void> {
  const setup = { remove: options.remove === true, caps: options.caps ? [...options.caps] : null };
  await page.addInitScript(({ remove, caps }: typeof setup) => {
    const w = window as unknown as Record<string, unknown>;
    if (remove) {
      delete w['RTCPeerConnection'];
      return;
    }
    const log: Record<string, unknown> = {
      pointer: [] as unknown[],
      input: [] as unknown[],
      screen: [] as unknown[],
      connections: 0,
    };
    w['__rtc'] = log;
    const connections: FakeConnection[] = [];
    w['__rtcAutoSame'] = false;
    // A rede some: o canal cai e as tentativas seguintes (o app tenta de novo depois de um recuo) também falham.
    w['__rtcDrop'] = () => {
      w['__rtcBroken'] = true;
      for (const connection of connections) connection.fail();
    };

    // O agente diz por que fechou o canal (`bye`) e o fecha: o aparelho que perdeu o canal para outro, a sessão revogada...
    w['__rtcBye'] = (reason: string) => {
      const last = connections.at(-1);
      const input = last?.channels.find((channel) => channel.label === 'input');
      input?.reply({ k: 'bye', r: reason });
    };

    // Avisa quando o canal de tela da conexão WebRTC estiver aberto e pronto para receber mensagens.
    w['__rtcScreenReady'] = () => {
      return connections.some((c) =>
        c.channels.some((ch) => ch.label === 'screen' && ch.readyState === 'open'),
      );
    };

    // Dispara mensagens em canais com label 'screen'.
    w['__rtcSendScreen'] = (data: unknown) => {
      for (const connection of connections) {
        for (const channel of connection.channels) {
          if (channel.label === 'screen') {
            channel.dispatchEvent(new MessageEvent('message', { data }));
          }
        }
      }
    };

    class FakeChannel extends EventTarget {
      readyState = 'connecting';
      bufferedAmount = 0;
      constructor(readonly label: string) {
        super();
      }
      reply(message: unknown) {
        setTimeout(() => {
          if (this.readyState === 'open') {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
          }
        }, 0);
      }
      send(data: unknown) {
        if (typeof data === 'string') {
          const message = JSON.parse(data) as Record<string, unknown>;
          if (!Array.isArray(log[this.label])) log[this.label] = [];
          (log[this.label] as unknown[]).push(message);
          if (this.label === 'input' && message['k'] === 'auth')
            this.reply(caps ? { k: 'ready', life: 600, caps } : { k: 'ready', life: 600 });
          if (this.label === 'input' && message['k'] === 'cmd') {
            this.reply({ k: 'ack', i: message['i'], ok: true });
          }
          if (this.label === 'pointer' && message['k'] === 'ping') {
            this.reply({ k: 'pong', n: message['n'], c: true });
          }
          if (this.label === 'screen' && message['k'] === 's.get' && w['__rtcAutoSame']) {
            this.reply({ k: 's.same', crc: 1 });
          }
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
        (log['connections'] as number)++;
        connections.push(this);
      }
      createDataChannel(label: string) {
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
  }, setup);
}

/** O agente avisa o motivo e fecha o canal (`replaced`, `revoked`, `lifetime`...). */
export async function byeRtc(page: Page, reason: string): Promise<void> {
  await page.evaluate(
    (r) => (window as unknown as { __rtcBye: (reason: string) => void }).__rtcBye(r),
    reason,
  );
}

export function rtcLog(page: Page): Promise<RtcLog | null> {
  return page.evaluate(() => (window as unknown as { __rtc?: RtcLog }).__rtc ?? null);
}

/** O canal cai de repente (rede perdida): o estado do par vira "falhou". */
export async function dropRtc(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __rtcDrop: () => void }).__rtcDrop());
}

/** Injeta a lista de monitores no canal WebRTC de tela. */
export async function injectRtcScreenMonitors(
  page: Page,
  monitors: Array<{ id: number; primary: boolean; width: number; height: number }>,
  layout = 1,
): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as unknown as { __rtcScreenReady?: () => boolean };
    return w.__rtcScreenReady?.() === true;
  });
  await page.evaluate(
    ({ monitors, layout }) => {
      const w = window as unknown as { __rtcSendScreen?: (data: unknown) => void };
      w.__rtcSendScreen?.(JSON.stringify({ k: 's.mon', monitors, layout }));
    },
    { monitors, layout },
  );
}

/** Injeta um quadro binário (UOSF v1 com JPEG válido) no canal WebRTC de tela. */
export async function injectRtcScreenFrame(
  page: Page,
  width = 640,
  height = 360,
  sequence = 1,
): Promise<void> {
  await page.evaluate(
    async ({ width, height, sequence }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#38bdf8';
        ctx.font = '24px sans-serif';
        ctx.fillText('Uniover Screen Test', 20, 40);
      }
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.8),
      );
      const jpegBytes = new Uint8Array(await blob.arrayBuffer());

      const packet = new Uint8Array(16 + jpegBytes.length);
      const view = new DataView(packet.buffer);
      view.setUint32(0, 0x554f5346); // UOSF
      view.setUint8(4, 1); // version 1
      view.setUint8(5, 0); // flags
      view.setUint16(6, width);
      view.setUint16(8, height);
      view.setUint16(10, sequence);
      view.setUint32(12, jpegBytes.length);
      packet.set(jpegBytes, 16);

      const w = window as unknown as {
        __rtcSendScreen?: (data: unknown) => void;
        __rtcAutoSame?: boolean;
      };
      w.__rtcSendScreen?.(packet.buffer);
      w.__rtcAutoSame = true;
    },
    { width, height, sequence },
  );
}
