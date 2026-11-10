import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  Injectable,
  InjectionToken,
  Injector,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../../core/config/app-config';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';

/** A capacidade que o agente do PC declara quando oferece o canal direto (WebRTC). */
export const PC_RTC_CAPABILITY = 'pc.rtc.v1';

const BASE = `${APP_CONFIG.apiBase}/v1/pc/rtc`;

/** Esperas (ms) entre as tentativas de abrir o canal depois de uma falha; a última se repete. */
export const DIRECT_BACKOFF_MS: readonly number[] = [5_000, 15_000, 60_000];
/** Quanto a coleta de candidatos pode levar antes de a oferta sair com o que já há. */
export const GATHER_TIMEOUT_MS = 2_000;
/** Prazo para os dois canais abrirem e o agente aceitar o token (o agente fecha em 15 s). */
export const OPEN_TIMEOUT_MS = 12_000;
/** De quanto em quanto tempo o sinal de vida vai ao agente (e dá o RTT). */
export const PING_MS = 1_000;
/** Sem resposta do sinal de vida por tanto tempo, o canal é dado como parado e a nuvem assume. */
export const STALL_MS = 2_500;
/** O comando que não recebe a resposta do agente no canal: resultado incerto (a mesma regra da nuvem). */
export const ACK_TIMEOUT_MS = 6_500;
/** Reenvio do último total do ponteiro depois de uma pausa: cobre a mensagem perdida sem retransmissão. */
export const POINTER_TAIL_MS = 60;
/** Quanto antes do fim da vida do canal o app abre outro (a vida vem do agente, no `ready`). */
export const RENEW_MARGIN_MS = 30_000;
/** O canal que durou isto (ou mais) antes de cair já provou que funciona: o recuo recomeça do início. */
export const STABLE_MS = 60_000;
/** Prazo para o agente firmar a escala de relógio (dois sinais de vida): sem ela, nenhum comando é aceito. */
export const CLOCK_TIMEOUT_MS = 4_000;
/** Teto da espera de silêncio da nuvem antes de o canal assumir (um pedido lento da nuvem não pode adiar o canal sem fim). */
export const MAX_CLOUD_IDLE_MS = 2_000;
/** Acima disto no buffer do canal do ponteiro, a mensagem é pulada (a próxima traz a soma). */
const MAX_BUFFERED_BYTES = 16_384;

/** Os comandos que o canal de entrada leva: os mesmos tipos `pc.*` da nuvem, só os de entrada. */
export type DirectCommandType =
  | 'pc.click.v1'
  | 'pc.click.v2'
  | 'pc.key.v1'
  | 'pc.key.v2'
  | 'pc.text.v1'
  | 'pc.text.v2'
  | 'pc.media.v1'
  | 'pc.pointer.zoom.v1'
  | 'pc.volume.v1';

/**
 * As mensagens v2 que só um agente que as lista no `ready` entende no canal (`caps`). Um agente anterior não manda o campo:
 * mandar a mensagem mesmo assim seria recusada (e contada como violação), e o clique ou o texto se perderia.
 */
const CHANNEL_LISTED_TYPES: ReadonlySet<DirectCommandType> = new Set<DirectCommandType>([
  'pc.click.v2',
  'pc.text.v2',
  'pc.pointer.zoom.v1',
  'pc.volume.v1',
]);

/** O comando nem saiu (o canal não está aberto agora): quem chama segue pela nuvem, sem risco de repetir. */
export class DirectNotSent extends Error {}

/** A resposta do `POST /pc/rtc/offer`. */
export interface PcDirectAnswer {
  readonly sessionId: string;
  readonly sdp: string;
  readonly token: string;
}

/**
 * A fábrica do `RTCPeerConnection`: `null` onde o navegador não tem WebRTC (o WebKit dos testes, um app antigo). Sem
 * servidor de terceiros (`iceServers` vazio): nenhum STUN de ninguém, nenhum IP público na oferta.
 */
export const PC_RTC_FACTORY = new InjectionToken<(() => RTCPeerConnection) | null>(
  'PC_RTC_FACTORY',
  {
    providedIn: 'root',
    factory: () =>
      typeof RTCPeerConnection === 'undefined'
        ? null
        : () => new RTCPeerConnection({ iceServers: [] }),
  },
);

/** A sinalização do canal direto: a oferta e o fechamento passam pela API autenticada. */
@Injectable({ providedIn: 'root' })
export class PcDirectSignaling {
  private readonly injector = inject(Injector);

  private get http(): HttpClient {
    return this.injector.get(HttpClient);
  }

  async offer(sdp: string): Promise<PcDirectAnswer> {
    const body = await firstValueFrom(this.http.post<unknown>(`${BASE}/offer`, { sdp }));
    const dto = body as Record<string, unknown> | null;
    if (
      !dto ||
      typeof dto['sessionId'] !== 'string' ||
      typeof dto['sdp'] !== 'string' ||
      typeof dto['token'] !== 'string'
    ) {
      throw new Error('resposta de oferta fora do formato');
    }
    return { sessionId: dto['sessionId'], sdp: dto['sdp'], token: dto['token'] };
  }

  async close(sessionId: string, keepalive = false): Promise<void> {
    await firstValueFrom(
      this.http.post(
        `${BASE}/${encodeURIComponent(sessionId)}/close`,
        null,
        keepalive ? { keepalive: true } : {},
      ),
    );
  }
}

interface Pending {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Link {
  readonly connection: RTCPeerConnection;
  readonly pointer: RTCDataChannel;
  readonly input: RTCDataChannel;
  sessionId: string | null;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A época de uma página: 64 bits aleatórios em 16 hexadecimais (o agente e a API validam esse formato). */
export function newCloudEpoch(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** O 409 `pc-direct-revoked`: a pessoa perdeu o acesso enquanto o canal abria. */
function isDirectRevoked(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) return false;
  const type = (error.error as { type?: unknown } | null)?.type;
  return typeof type === 'string' && type.endsWith('/pc-direct-revoked');
}

/** Um erro que a tela já sabe traduzir (`pcFailureOf`): o canal fala a língua das respostas da API. */
function failureFor(code: string | undefined): HttpErrorResponse {
  switch (code) {
    case 'rate_limited':
      return new HttpErrorResponse({ status: 429 });
    case 'invalid_message':
    case 'not_allowed':
      return new HttpErrorResponse({ status: 400 });
    case 'expired':
    case 'not_ready':
      return new HttpErrorResponse({ status: 504 });
    default:
      return new HttpErrorResponse({ status: 502, error: { agentError: code ?? 'failed' } });
  }
}

/**
 * O canal direto (WebRTC) entre o app e o PC: um acelerador OPCIONAL. A nuvem continua sendo o caminho de sempre e a
 * reserva automática: qualquer falha ao abrir, qualquer queda ou parada do canal devolve tudo a ela, sem aviso e sem
 * que a tela perceba além do ponto de estado.
 *
 * - **Quando tenta:** com a tela do PC aberta e visível, o PC conectado e declarando `pc.rtc.v1`, e o navegador tendo
 *   WebRTC. Falhou, tenta de novo com recuo (5, 15, 60 s). Escondeu a página, fecha (o agente solta o que o PC segurava).
 * - **Quando usa:** só com o canal aberto E nenhum pedido da nuvem ainda em voo (ver {@link trackCloud}): o que já saiu
 *   pela nuvem termina antes de o seguinte sair pelo canal, então nada passa na frente de nada na troca. Na volta (o
 *   canal caiu) a nuvem assume na hora; o que estava no canal sem resposta fica como resultado incerto, nunca reenviado.
 * - **O que leva:** o ponteiro vai num canal sem ordem nem retransmissão como TOTAL acumulado com número de sequência
 *   (a mensagem perdida não perde caminho; a atrasada é ignorada pelo agente), e cliques, teclas, texto e mídia vão no
 *   canal ordenado e confiável, cada um com o total do ponteiro daquele instante (o clique nunca passa na frente do
 *   movimento que o antecedeu) e a resposta do agente. Energia e favoritos só pela nuvem (confirmação e trilha na API).
 * - **Segurança:** a oferta e a resposta (com a impressão digital DTLS) passam pela API autenticada, e a primeira
 *   mensagem do canal leva o token de uso único que ela emitiu.
 */
@Injectable({ providedIn: 'root' })
export class PcDirect {
  private readonly availability = inject(PcAvailability);
  private readonly session = inject(SessionState);
  private readonly signaling = inject(PcDirectSignaling);
  private readonly factory = inject(PC_RTC_FACTORY);

  private wanted = false;
  /** Outro aparelho tomou o canal, ou a sessão deixou de valer: só uma ação da pessoa (a tela abrir de novo) tenta outra vez. */
  private suspended = false;
  /**
   * A API disse que a pessoa perdeu o acesso (409 `pc-direct-revoked`, ou o agente fechou com `revoked`): nada de nova tentativa
   * com recuo. Volta com a tela abrindo de novo ou quando o token de acesso é renovado (`revokedAtExpiry` é o vencimento de
   * quando isso aconteceu: mudou, a sessão foi renovada).
   */
  private revoked = false;
  private revokedAtExpiry: number | null = null;
  /** O canal já levou o primeiro comando: daqui em diante os comandos de entrada vão só por ele (a nuvem fecha o canal em uso). */
  private adopted = false;
  private openedAt = 0;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewPending = false;
  private clockWaiter: (() => void) | null = null;
  private busyProbe: (() => boolean) | null = null;
  private connecting = false;
  private link: Link | null = null;
  private attempts = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPong = 0;
  private pingCount = 0;
  private readonly pingSentAt = new Map<number, number>();
  private lastRtt: number | null = null;
  private lifeSeconds = 0;
  /** As mensagens v2 que o agente deste canal listou no `ready` (vazio até ele responder, e com um agente anterior). */
  private channelTypes: ReadonlySet<string> = new Set();
  private readyWaiter: (() => void) | null = null;
  private readonly pending = new Map<string, Pending>();
  private commandCount = 0;
  private cloudInFlight = 0;
  /**
   * O último número (`seq`) dado a um pedido de clique, tecla, texto ou mídia pela nuvem (crescente na vida da página). Vai ao
   * agente como marcador (`cs`) no `auth` e em cada comando do canal: o que a nuvem entregar com número até ele é anterior à
   * troca de caminho (chegou tarde) e não fecha o canal; um número maior é pedido novo da nuvem e fecha.
   */
  private cloudSeq = 0;
  /**
   * A época desta página (sorteada quando ela abre): o contador acima recomeça do zero numa página reaberta, então o `seq`
   * sozinho não diz de qual página vem. Vai junto com o `seq` nos pedidos da nuvem e com o marcador (`ce`) no canal.
   */
  readonly cloudEpoch = newCloudEpoch();
  /** Quando o último pedido da nuvem terminou, e quanto ele levou (a "ida e volta" da nuvem, com teto). */
  private lastCloudDoneAt = 0;
  private cloudRtt = 0;
  private readonly lostListeners = new Set<() => void>();
  private cleanup: (() => void) | null = null;
  private account = this.session.accountId();

  /** O canal está aberto e o agente aceitou o token. */
  private readonly open = signal(false);
  /** Por onde os comandos saem agora, para o ponto de estado da tela. */
  readonly mode = computed<'direct' | 'cloud'>(() => (this.open() ? 'direct' : 'cloud'));
  /** O último tempo de ida e volta medido no canal (ms), ou `null`. */
  readonly rtt = signal<number | null>(null);

  // Os totais do ponteiro desde que o canal abriu, e o número da última mensagem.
  private seq = 0;
  private totals = { x: 0, y: 0, w: 0, h: 0 };

  constructor() {
    effect(() => {
      this.availability.status();
      this.session.accountId();
      this.session.expiresAt();
      untracked(() => {
        // O token de acesso foi renovado: o acesso pode ter voltado, e a próxima avaliação tenta o canal.
        if (this.revoked && this.session.expiresAt() !== this.revokedAtExpiry) this.revoked = false;
        // Outra conta na aba: o canal era do PC da anterior.
        if (this.session.accountId() !== this.account) {
          this.account = this.session.accountId();
          this.teardown('account', { quiet: true });
        }
        this.evaluate();
      });
    });
  }

  /**
   * O canal pode levar o próximo comando de entrada agora. O primeiro só sai por ele com a nuvem sem nada em voo E em silêncio
   * há pelo menos uma ida e volta dela (a resposta da nuvem sai antes de o agente ler o pedido: sem essa folga, um movimento
   * ainda a caminho chegaria depois do primeiro comando do canal). Dali em diante é só ele: o agente fecha o canal em uso no
   * instante em que chega um comando de entrada novo pela nuvem (para um aperto atrasado do canal nunca cair depois de um
   * soltar da nuvem), então misturar os dois derrubaria o canal.
   */
  canUse(): boolean {
    if (!this.open()) return false;
    if (!this.adopted && this.cloudInFlight === 0 && this.cloudQuiet()) this.adopted = true;
    return this.adopted;
  }

  /**
   * O agente deste canal entende este comando? Os de sempre sim (todo agente com canal os tem); as mensagens v2 novas só se
   * ele as listou no `ready`. Quando não, quem chama manda pela nuvem, onde a API confere o que o agente de agora declarou.
   */
  accepts(type: DirectCommandType): boolean {
    return !CHANNEL_LISTED_TYPES.has(type) || this.channelTypes.has(type);
  }

  /** A nuvem está em silêncio há pelo menos uma ida e volta dela (nunca usada: já está). */
  private cloudQuiet(): boolean {
    return Date.now() - this.lastCloudDoneAt >= this.cloudRtt;
  }

  /** O número do próximo pedido de clique, tecla, texto ou mídia pela nuvem (um contador só, crescente). */
  nextCloudSeq(): number {
    return ++this.cloudSeq;
  }

  /**
   * Quem usa o canal diz se algo está segurado no PC (botão, modificador). A renovação do canal (a vida dele é curta) espera
   * isto acabar: trocar de canal no meio de um arrasto o soltaria.
   */
  setBusyProbe(probe: (() => boolean) | null): void {
    this.busyProbe = probe;
  }

  /**
   * Marca um pedido da nuvem em voo até terminar. O canal só passa a levar comandos quando nenhum está em voo: o que saiu
   * antes pela nuvem termina antes do que sai depois pelo canal.
   */
  trackCloud<T>(call: Promise<T>): Promise<T> {
    this.cloudInFlight++;
    const started = Date.now();
    const done = () => {
      this.cloudInFlight--;
      const now = Date.now();
      this.lastCloudDoneAt = now;
      this.cloudRtt = Math.min(MAX_CLOUD_IDLE_MS, Math.max(0, now - started));
    };
    call.then(done, done);
    return call;
  }

  /** Avisa quando o canal cai sem a tela ter pedido (a tela solta o que o PC segurava e segue pela nuvem). */
  onLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /** A tela do PC abriu: passa a tentar o canal enquanto ela estiver visível. */
  start(): void {
    this.suspended = false; // abrir a tela de novo é uma ação da pessoa: tenta outra vez
    this.revoked = false;
    if (this.wanted) {
      this.evaluate();
      return;
    }
    this.wanted = true;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.teardown('hidden', { keepalive: true });
      } else {
        // A pessoa voltou: tenta já, sem esperar o recuo de uma tentativa de antes de esconder.
        this.clearBackoff();
        this.evaluate();
      }
    };
    const onPageHide = () => this.teardown('hidden', { keepalive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    this.cleanup = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
    this.evaluate();
  }

  /** A tela do PC fechou: o canal fecha junto (o agente solta o que o PC segurava). */
  stop(): void {
    this.wanted = false;
    this.cleanup?.();
    this.cleanup = null;
    this.clearBackoff();
    this.attempts = 0;
    this.teardown('stopped', {});
  }

  /** Movimento do dedo, já somado pela tela. O total acumulado cobre qualquer mensagem que se perca. */
  sendPointer(dx: number, dy: number, scrollX: number, scrollY: number): void {
    const link = this.link;
    if (!link || !this.open()) throw new DirectNotSent();
    this.totals.x += dx;
    this.totals.y += dy;
    this.totals.w += scrollX;
    this.totals.h += scrollY;
    const heartbeat = dx === 0 && dy === 0 && scrollX === 0 && scrollY === 0;
    this.seq++;
    this.emitPointer(link, heartbeat);
    // Uma pausa depois do último movimento: o mesmo total outra vez (o agente ignora se a primeira chegou).
    if (this.tailTimer !== null) clearTimeout(this.tailTimer);
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      if (this.link === link && this.open()) this.emitPointer(link, false);
    }, POINTER_TAIL_MS);
  }

  /**
   * Manda um comando no canal de entrada e espera a resposta do agente. Se o canal não está aberto, lança
   * {@link DirectNotSent} (nada saiu). Se ele cai ou o agente não responde no prazo depois de enviado, o resultado é
   * incerto: o erro tem o mesmo formato da nuvem (504) e o comando NÃO é reenviado por outro caminho.
   */
  command(type: DirectCommandType, body: Record<string, unknown>): Promise<void> {
    const link = this.link;
    if (!link || !this.open() || link.input.readyState !== 'open') {
      return Promise.reject(new DirectNotSent());
    }
    const id = `c${++this.commandCount}`;
    const message = {
      k: 'cmd',
      i: id,
      t: type,
      b: body,
      ts: Date.now(),
      cs: this.cloudSeq,
      ce: this.cloudEpoch,
      p: { s: this.seq, x: this.totals.x, y: this.totals.y, w: this.totals.w, h: this.totals.h },
    };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpErrorResponse({ status: 504 }));
      }, ACK_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        link.input.send(JSON.stringify(message));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        // O comando não saiu, mas o canal ainda se diz aberto: quem chama vai recuar para a nuvem. O canal deixa de ser o dono da
        // entrada até a nuvem terminar o que ela vai levar, senão o próximo comando sairia por ele e passaria na frente deste.
        // A nuvem também deixa de estar "quieta" a partir de agora: entre esta recusa e o pedido dela entrar em voo há passos
        // assíncronos, e um comando já à espera readotaria o canal nesse meio. A folga máxima vale até a nuvem terminar.
        this.adopted = false;
        this.lastCloudDoneAt = Date.now();
        this.cloudRtt = MAX_CLOUD_IDLE_MS;
        reject(new DirectNotSent());
      }
    });
  }

  // ---- abrir -----------------------------------------------------------------------------------

  private evaluate(): void {
    if (
      !this.wanted ||
      this.suspended ||
      this.revoked ||
      this.open() ||
      this.connecting ||
      this.backoffTimer !== null
    )
      return;
    if (this.factory === null || document.visibilityState === 'hidden') return;
    const status = this.availability.status();
    if (!status?.online || !status.capabilities.includes(PC_RTC_CAPABILITY)) return;
    void this.connect(this.factory);
  }

  private async connect(factory: () => RTCPeerConnection): Promise<void> {
    this.connecting = true;
    let link: Link | null = null;
    try {
      const connection = factory();
      const pointer = connection.createDataChannel('pointer', {
        ordered: false,
        maxRetransmits: 0,
      });
      const input = connection.createDataChannel('input', { ordered: true });
      link = { connection, pointer, input, sessionId: null };
      this.link = link;
      this.listen(link);
      await connection.setLocalDescription(await connection.createOffer());
      await this.gathered(connection);
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error('sem oferta');
      const answer = await this.signaling.offer(sdp);
      link.sessionId = answer.sessionId;
      if (this.link !== link) {
        // Fechou enquanto negociava: avisa a API (e o agente) que a sessão acabou.
        void this.signaling.close(answer.sessionId).catch(() => undefined);
        return;
      }
      await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await this.opened(link);
      if (this.link !== link) return;
      const ready = new Promise<void>((resolve) => {
        this.readyWaiter = resolve;
      });
      this.lifeSeconds = 0;
      this.channelTypes = new Set();
      link.input.send(
        JSON.stringify({ k: 'auth', tok: answer.token, cs: this.cloudSeq, ce: this.cloudEpoch }),
      );
      await Promise.race([
        ready,
        pause(OPEN_TIMEOUT_MS).then(() => Promise.reject(new Error('sem ready'))),
      ]);
      if (this.link !== link) return;
      // O agente só aceita entrada depois de firmar a escala de relógio com dois sinais de vida; o canal só vale daqui.
      await this.syncClock(link);
      if (this.link !== link) return;
      this.onOpen(this.lifeSeconds);
    } catch (error) {
      if (isDirectRevoked(error)) this.markRevoked();
      if (link !== null && this.link === link) this.teardown('failed', {});
      else if (link !== null) this.discard(link);
      this.scheduleRetry();
    } finally {
      this.connecting = false;
      this.readyWaiter = null;
    }
  }

  /** Espera a coleta de candidatos terminar (ou o prazo curto): a oferta sai inteira, sem depender de trickle. */
  private gathered(connection: RTCPeerConnection): Promise<void> {
    if (connection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        connection.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      function check() {
        if (connection.iceGatheringState === 'complete') done();
      }
      connection.addEventListener('icegatheringstatechange', check);
    });
  }

  private opened(link: Link): Promise<void> {
    const channels = [link.pointer, link.input];
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('canais não abriram')), OPEN_TIMEOUT_MS);
      const check = () => {
        if (channels.every((channel) => channel.readyState === 'open')) {
          clearTimeout(timer);
          resolve();
        }
      };
      for (const channel of channels) channel.addEventListener('open', check);
      check();
    });
  }

  private listen(link: Link): void {
    link.input.addEventListener('message', (event) => this.onInput(link, event.data));
    link.pointer.addEventListener('message', (event) => this.onPointer(link, event.data));
    const lost = () => {
      if (this.link === link) this.teardown('closed', { unexpected: true });
    };
    link.input.addEventListener('close', lost);
    link.pointer.addEventListener('close', lost);
    link.connection.addEventListener('connectionstatechange', () => {
      const state = link.connection.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') lost();
    });
  }

  /** Manda o par de sinais de vida que firma a escala de relógio no agente e espera ele dizer que a tem (`c` no `pong`). */
  private async syncClock(link: Link): Promise<void> {
    const synced = new Promise<void>((resolve) => {
      this.clockWaiter = resolve;
    });
    this.sendPing(link);
    const timer = setInterval(() => this.sendPing(link), 120);
    try {
      await Promise.race([
        synced,
        pause(CLOCK_TIMEOUT_MS).then(() => Promise.reject(new Error('sem relógio'))),
      ]);
    } finally {
      clearInterval(timer);
      this.clockWaiter = null;
    }
  }

  private sendPing(link: Link): void {
    const n = ++this.pingCount;
    this.pingSentAt.set(n, performance.now());
    if (this.pingSentAt.size > 8)
      this.pingSentAt.delete(this.pingSentAt.keys().next().value as number);
    if (link.pointer.readyState !== 'open') return;
    try {
      link.pointer.send(JSON.stringify({ k: 'ping', n, t: Date.now(), r: this.lastRtt }));
    } catch {
      // idem: o `close` derruba
    }
  }

  private onOpen(lifeSeconds: number): void {
    // O recuo NÃO volta ao início só porque o canal abriu (dois aparelhos se trocando abriam e perdiam o canal em laço): ele
    // recomeça quando um canal dura `STABLE_MS` (ver `teardown`).
    this.openedAt = Date.now();
    this.adopted = false;
    this.renewPending = false;
    this.seq = 0;
    this.totals = { x: 0, y: 0, w: 0, h: 0 };
    this.lastPong = Date.now();
    this.pingSentAt.clear();
    this.open.set(true);
    this.pingTimer = setInterval(() => this.ping(), PING_MS);
    // A vida do canal é curta (a da sessão que o autorizou): abre outro um pouco antes do fim, sem ninguém notar.
    if (lifeSeconds > 0) {
      const wait = Math.max(5_000, lifeSeconds * 1000 - RENEW_MARGIN_MS);
      this.renewTimer = setTimeout(() => {
        this.renewTimer = null;
        this.renewPending = true;
      }, wait);
    }
  }

  // ---- mensagens -------------------------------------------------------------------------------

  private onInput(link: Link, data: unknown): void {
    if (this.link !== link) return;
    const message = parse(data);
    if (message?.['k'] === 'ready') {
      this.lifeSeconds = typeof message['life'] === 'number' ? message['life'] : 0;
      const caps = message['caps'];
      this.channelTypes = new Set(
        Array.isArray(caps) ? caps.filter((cap): cap is string => typeof cap === 'string') : [],
      );
      this.readyWaiter?.();
    } else if (message?.['k'] === 'bye') {
      this.onBye(typeof message['r'] === 'string' ? message['r'] : '');
    } else if (message?.['k'] === 'ack' && typeof message['i'] === 'string') {
      const waiting = this.pending.get(message['i']);
      if (!waiting) return;
      this.pending.delete(message['i']);
      clearTimeout(waiting.timer);
      if (message['ok'] === true) waiting.resolve();
      else waiting.reject(failureFor(typeof message['c'] === 'string' ? message['c'] : undefined));
    }
  }

  /**
   * O agente diz por que fechou o canal. `replaced` (outro aparelho tomou o lugar) e `revoked` (a sessão, a senha, a conta ou
   * a permissão deixou de valer): nenhuma tentativa sozinha, só a próxima vez que a tela abrir. `lifetime`: a vida acabou, abre
   * outro já. Os demais seguem o recuo de sempre.
   */
  private onBye(reason: string): void {
    if (reason === 'replaced') {
      this.suspended = true;
      this.teardown(reason, { unexpected: true });
    } else if (reason === 'revoked') {
      this.markRevoked();
      this.teardown(reason, { unexpected: true });
    } else if (reason === 'lifetime') {
      this.teardown(reason, { unexpected: true, renew: true });
    } else {
      this.teardown(reason, { unexpected: true });
    }
  }

  private onPointer(link: Link, data: unknown): void {
    if (this.link !== link) return;
    const message = parse(data);
    if (message?.['k'] !== 'pong' || typeof message['n'] !== 'number') return;
    this.lastPong = Date.now();
    if (message['c'] === true) this.clockWaiter?.();
    const sent = this.pingSentAt.get(message['n']);
    if (sent !== undefined) {
      this.pingSentAt.delete(message['n']);
      this.lastRtt = Math.max(0, Math.round(performance.now() - sent));
      this.rtt.set(this.lastRtt);
    }
  }

  private emitPointer(link: Link, heartbeat: boolean): void {
    if (link.pointer.readyState !== 'open' || link.pointer.bufferedAmount > MAX_BUFFERED_BYTES)
      return;
    const { x, y, w, h } = this.totals;
    const message: Record<string, unknown> = { k: 'ptr', s: this.seq, x, y, w, h };
    if (heartbeat) message['hb'] = 1;
    try {
      link.pointer.send(JSON.stringify(message));
    } catch {
      // o canal fechou agora: o `close` já derruba o estado
    }
  }

  private ping(): void {
    const link = this.link;
    if (!link || !this.open()) return;
    if (Date.now() - this.lastPong > STALL_MS) {
      this.teardown('stalled', { unexpected: true });
      return;
    }
    // O canal pediu renovação (vida perto do fim) e nada está segurado: troca agora, de modo transparente.
    if (this.renewPending && this.busyProbe?.() !== true) {
      this.teardown('renew', {});
      this.attempts = 0;
      this.clearBackoff();
      this.evaluate();
      return;
    }
    this.sendPing(link);
  }

  // ---- fechar ----------------------------------------------------------------------------------

  /**
   * Fecha o canal e devolve tudo à nuvem. O que estava no canal sem resposta fica incerto (504, nunca reenviado). `unexpected`
   * é a queda que a tela não pediu: ela solta o que o PC segurava e o canal volta a tentar com recuo.
   */
  private teardown(
    reason: string,
    options: {
      readonly keepalive?: boolean;
      readonly unexpected?: boolean;
      readonly quiet?: boolean;
      /** A vida do canal acabou: abre outro na hora, sem recuo. */
      readonly renew?: boolean;
    },
  ): void {
    const link = this.link;
    if (link === null) return;
    this.link = null;
    const wasOpen = this.open();
    const lived = wasOpen ? Date.now() - this.openedAt : 0;
    this.open.set(false);
    this.adopted = false;
    this.renewPending = false;
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    this.renewTimer = null;
    this.rtt.set(null);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.tailTimer !== null) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    this.pingSentAt.clear();
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new HttpErrorResponse({ status: 504 }));
    }
    this.pending.clear();
    this.discard(link, options.keepalive === true);
    if (options.unexpected === true && wasOpen) {
      for (const listener of [...this.lostListeners]) listener();
    }
    // A queda que a tela não pediu volta a tentar com recuo (5, 15, 60 s), tenha o canal chegado a abrir ou não. Um canal que
    // durou o bastante provou que funciona e zera o recuo; um que caiu logo (dois aparelhos disputando) o faz crescer.
    if (options.unexpected === true) {
      if (lived >= STABLE_MS) this.attempts = 0;
      if (options.renew === true) {
        this.attempts = 0;
        this.clearBackoff();
        queueMicrotask(() => this.evaluate());
      } else {
        this.scheduleRetry();
      }
    }
    void reason;
  }

  private discard(link: Link, keepalive = false): void {
    try {
      link.input.close();
      link.pointer.close();
      link.connection.close();
    } catch {
      // já estava fechado
    }
    if (link.sessionId !== null) {
      void this.signaling.close(link.sessionId, keepalive).catch(() => undefined);
      link.sessionId = null;
    }
  }

  private markRevoked(): void {
    this.revoked = true;
    this.revokedAtExpiry = this.session.expiresAt();
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.suspended || this.revoked || this.backoffTimer !== null) return;
    const wait = DIRECT_BACKOFF_MS[Math.min(this.attempts, DIRECT_BACKOFF_MS.length - 1)] ?? 60_000;
    this.attempts++;
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.evaluate();
    }, wait);
  }

  private clearBackoff(): void {
    if (this.backoffTimer !== null) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
  }
}

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
