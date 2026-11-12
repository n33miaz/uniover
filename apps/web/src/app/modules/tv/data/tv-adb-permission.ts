import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { TvApi } from './tv-api';
import { TvSelection } from './tv-selection';
import { describeFailure } from './tv-errors';
import type { AdbPermission } from './tv-types';

/** De quanto em quanto tempo se confere o estado enquanto o aviso está na TV, e por quanto tempo no máximo. */
export const ADB_WAIT_POLL_MS = 3000;
/** O agente espera o aceite por 90 s: a espera aqui passa um pouco disso, para o fim vir dele e não do relógio. */
export const ADB_WAIT_MS = 100_000;
/** Quanto tempo o "Pronto" fica à vista, e o recado de que o registro foi apagado. */
export const ADB_DONE_MS = 4000;
export const ADB_CLEARED_MS = 8000;
/** O motivo do agente quando o registro foi apagado (pareamento novo com outro aparelho no endereço). */
export const ADB_CLEARED_REASON = 'registration_cleared';
/** Depois de um pedido recusado: quantas vezes, e de quanto em quanto, se confere se o aviso chegou à TV (`pending`). */
export const ADB_CONFIRM_POLL_MS = 1200;
export const ADB_CONFIRM_TRIES = 3;
/** "Agora não" vale por este tempo, por TV, neste aparelho. */
export const ADB_DISMISS_MS = 24 * 60 * 60 * 1000;
/** Onde "Agora não" fica guardado (por TV): sobrevive a recarregar e a fechar o app. */
export const ADB_DISMISSED_KEY = 'uniover.tv.adb-permission.dismissed';
/** O único motivo do agente que abre a folha sozinha: a TV recusou uma chave que já tinha aceitado. */
export const ADB_FORGOT_REASON = 'tv_forgot';

/** Em que ponto a folha "Liberar na TV" está. */
export type AdbSheetPhase =
  | 'intro'
  | 'asking'
  | 'unreachable'
  | 'expired'
  | 'failed'
  | 'noprompt'
  | 'notfound'
  | 'confirmsame';

/**
 * A permissão do ADB na TV vista da tela do controle (e do TV Livre). O agente nunca abre o aviso do ADB sozinho: só um
 * toque da pessoa o faz aparecer na TV. Quando algo que precisa do ADB falha por falta de permissão, ou o agente conta
 * que ela falta (`missing`), a tela abre uma folha curta, que **não bloqueia** o controle, com "Pedir na TV". Enquanto o
 * aviso está na TV (`pending`) um recado fixo no celular diz o que fazer ali. Toda vez que o aviso aparece na TV o
 * celular mostra esse recado, também quando foi um caminho automático que o abriu.
 *
 * Sem insistir: "Agora não" cala a folha por 24 h nesta TV, neste aparelho (a falta continua à vista nos atalhos, por
 * `needs`, e uma falha seguinte vira só um aviso curto). A folha também não abre sobre um painel que já bloqueia a tela.
 * Sozinha, pelo estado, ela só abre quando a TV **esqueceu** uma permissão que já tinha dado (`tv_forgot`); nunca para uma
 * TV que ainda nunca foi liberada. O recado do aceite só aparece quando o agente conta `pending`: um pedido recusado sem
 * `pending` não mostrou aviso nenhum na TV, e a pessoa fica sabendo disso.
 *
 * Quem aceita o aviso na TV deixa a permissão como `granted`, mas só um toque da pessoa a prova (o agente não conecta
 * sozinho antes disso). Por isso, ao ver o aceite, esta classe faz **um** pedido de lista a mais, a continuação do mesmo
 * toque de "Pedir na TV": é ele que prova a permissão e libera os atalhos.
 */
@Injectable({ providedIn: 'root' })
export class TvAdbPermission {
  private readonly api = inject(TvApi);
  private readonly doc = inject(DOCUMENT);
  private readonly selection = inject(TvSelection);
  private readonly session = inject(SessionState);

  /** O ADB da TV está pedindo permissão: os atalhos mostram um sinal discreto. */
  readonly needs = signal(false);
  readonly sheetOpen = signal(false);
  readonly phase = signal<AdbSheetPhase>('intro');
  /** O aviso está na TV, esperando o aceite: o recado fixo aparece no celular. */
  readonly waiting = signal(false);
  /** A TV acabou de aceitar: um "Pronto" curto. */
  readonly done = signal(false);
  /** O registro da permissão foi apagado porque a TV mudou (pareamento novo): um recado calmo, por alguns segundos. */
  readonly cleared = signal(false);
  readonly asking = computed(() => this.phase() === 'asking');
  /** Refazer o registro do ADB é do dono da TV (a API recusa as outras contas): convidados veem "Peça ao dono da TV". */
  readonly canRebind = computed(() => !this.session.isGuest());

  /** Um pedido da pessoa foi recusado e se confere se o aviso chegou à TV: um `missing` antigo não vale nesse intervalo. */
  private confirming = false;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** Uma ação foi recusada enquanto um painel bloqueava a tela: a folha abre quando ele fechar. */
  private deferred = false;
  private deferredPhase: AdbSheetPhase = 'intro';
  /** Quantas telas hospedam a folha agora (sem nenhuma, nada se mostraria: quem chama mostra o erro curto). */
  private hosts = 0;
  private sawPending = false;
  private proofsLeft = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private expireTimer: ReturnType<typeof setTimeout> | undefined;
  private doneTimer: ReturnType<typeof setTimeout> | undefined;
  private clearedTimer: ReturnType<typeof setTimeout> | undefined;
  /** O recado do registro apagado já foi dado para este motivo (o estado repete o motivo a cada mensagem). */
  private clearedTold = false;

  /**
   * Uma ação que precisa do ADB falhou por falta de permissão. Devolve `true` se a tela já cuida disso (a folha abriu, ou
   * o aviso já está na TV) e `false` se quem chamou deve mostrar o erro curto (a pessoa disse "Agora não", ou há um painel
   * bloqueando a tela e a folha ficaria atrás dele).
   */
  denied(): boolean {
    this.needs.set(true);
    if (this.hosts === 0) return false;
    if (this.waiting() || this.sheetOpen()) return true;
    if (this.isDismissed()) return false;
    if (this.blockedByModal()) {
      this.deferred = true;
      this.deferredPhase = 'intro';
      return false;
    }
    this.open('intro');
    return true;
  }

  /**
   * O pedido da própria pessoa (Atualizar lista, uma ação do TV Livre) voltou recusado por falta de permissão: o agente
   * conectou e, se tudo correu bem, o aviso está na TV. O recado do aceite só aparece quando o agente conta `pending`
   * (confere algumas vezes); sem isso o pedido não mostrou aviso nenhum, e a folha diz "A TV não mostrou o pedido"
   * (`onUnconfirmed` cuida do caso em que a folha não pode abrir). Um agente que não conta o estado não deixa conferir:
   * vale o recado, como antes. O aceite, quando vem, é provado por mais um pedido, que só existe depois deste toque.
   * Devolve `false` se nenhuma tela mostraria nada (quem chama mostra o erro).
   */
  prompted(onUnconfirmed?: () => void): boolean {
    this.needs.set(true);
    if (this.hosts === 0) return false;
    this.proofsLeft = 1;
    if (this.waiting()) return true;
    this.confirmPrompt(onUnconfirmed);
    return true;
  }

  /**
   * A pessoa tocou no pedido que põe o aviso na TV (Atualizar lista, "Pedir na TV"): a prova fica armada já no toque,
   * porque o aceite (`granted`, pelo fluxo) pode chegar antes da resposta recusada do pedido. Quem chama desarma
   * (`disarm`) quando o pedido termina sem precisar de prova; dar certo (`confirmed`) também desarma.
   */
  arm(): void {
    this.proofsLeft = 1;
  }

  disarm(): void {
    this.proofsLeft = 0;
  }

  /** Uma tela passou a hospedar a folha e o recado (e deixou de hospedar, ao sair). */
  attach(): void {
    this.hosts += 1;
  }

  detach(): void {
    this.hosts = Math.max(0, this.hosts - 1);
    if (this.hosts === 0) this.reset();
  }

  /** Um painel modal fechou: se uma recusa ficou esperando por ele, a folha abre agora. */
  modalClosed(): void {
    if (!this.deferred || this.blockedByModal()) return;
    this.deferred = false;
    if (this.needs() && this.hosts > 0 && !this.isDismissed()) this.open(this.deferredPhase);
  }

  /** Algo que usa o ADB deu certo: a permissão está valendo. */
  confirmed(): void {
    this.proofsLeft = 0;
    this.needs.set(false);
    if (this.waiting()) this.endWaiting();
    this.sheetOpen.set(false);
  }

  /**
   * O estado que o agente conta (`null`: não diz) e o motivo, quando é `missing`. `pending` mostra o recado do aceite,
   * `granted` fecha tudo e `missing` só abre a folha sozinho quando a TV esqueceu uma permissão que tinha dado.
   */
  observe(value: AdbPermission | null | undefined, reason?: string | null): void {
    this.tellIfCleared(value, reason);
    switch (value) {
      case 'granted':
        this.granted();
        return;
      case 'pending':
        this.needs.set(true);
        this.sheetOpen.set(false);
        this.stopConfirming();
        if (!this.waiting()) this.startWaiting();
        this.sawPending = true;
        return;
      case 'missing':
        this.needs.set(true);
        // Só o fim do aviso (visto como `pending` antes) é o "ninguém aceitou"; um `missing` anterior ao pedido não é.
        if (this.waiting() && this.sawPending) this.expire();
        else if (!this.waiting() && !this.confirming && reason === ADB_FORGOT_REASON) this.denied();
        return;
      default:
        return;
    }
  }

  /**
   * Outro aparelho responde no endereço da TV (o agente se recusa a falar com ele): a folha diz isso e oferece "É a
   * mesma TV". Como `denied`, devolve `false` se quem chamou deve mostrar o erro curto.
   */
  deviceChanged(): boolean {
    this.needs.set(true);
    if (this.hosts === 0) return false;
    if (this.sheetOpen()) return true;
    if (this.isDismissed()) return false;
    if (this.blockedByModal()) {
      this.deferred = true;
      this.deferredPhase = 'notfound';
      return false;
    }
    this.open('notfound');
    return true;
  }

  /** "É a mesma TV": antes de qualquer coisa a folha pergunta de novo (trocar o aparelho do registro é sério). */
  askSameTv(): void {
    if (this.asking() || !this.canRebind()) return;
    this.phase.set('confirmsame');
  }

  /** Volta da pergunta "Esta é a mesma TV?" sem mudar nada. */
  backFromSameTv(): void {
    if (this.phase() === 'confirmsame') this.phase.set('notfound');
  }

  /**
   * "Sim, é a mesma": a pessoa confirmou. O agente refaz o registro do ADB para o aparelho de agora (explícito,
   * auditado) e, em seguida, vem o pedido de permissão de sempre: a TV mostra o aviso se não confia na chave.
   */
  async confirmSameTv(): Promise<void> {
    if (this.asking() || !this.canRebind()) return;
    this.phase.set('asking');
    try {
      await this.api.rebindAdb();
    } catch (error) {
      this.phase.set(this.failurePhase(describeFailure(error).kind));
      return;
    }
    await this.request();
  }

  /** "Pedir na TV": faz o pedido da pessoa que mostra o aviso na TV (o mesmo de Atualizar lista). */
  async ask(): Promise<void> {
    if (this.asking()) return;
    this.phase.set('asking');
    await this.request();
  }

  private failurePhase(kind: string): AdbSheetPhase {
    if (kind === 'adb-device-changed') return 'notfound';
    if (kind === 'agent-offline' || kind === 'agent-reconnecting') return 'unreachable';
    return 'failed';
  }

  private async request(): Promise<void> {
    this.arm();
    try {
      await this.api.refreshShortcuts();
      // A TV já guardava a permissão: não houve aviso, e o pedido já a provou.
      this.granted(false);
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.kind === 'adb-permission') {
        // A folha segue "pedindo" até o agente contar o aviso (`pending`) ou o intervalo acabar.
        this.prompted();
      } else {
        this.disarm();
        this.phase.set(this.failurePhase(failure.kind));
      }
    }
  }

  /** "Agora não": cala a folha por 24 h nesta TV, neste aparelho. */
  dismiss(): void {
    this.rememberDismissal();
    this.proofsLeft = 0;
    this.stopConfirming();
    this.sheetOpen.set(false);
    this.phase.set('intro');
  }

  /** O que sobrou ao sair da tela: tempos e recado. */
  reset(): void {
    this.deferred = false;
    this.proofsLeft = 0;
    this.stopConfirming();
    this.stopWaiting();
    clearTimeout(this.doneTimer);
    clearTimeout(this.clearedTimer);
    this.clearedTold = false;
    this.cleared.set(false);
    this.sheetOpen.set(false);
    this.waiting.set(false);
    this.done.set(false);
    this.phase.set('intro');
  }

  private open(phase: AdbSheetPhase): void {
    this.phase.set(phase);
    this.sheetOpen.set(true);
  }

  private granted(prove = true): void {
    const wasWaiting = this.waiting();
    this.stopConfirming();
    this.needs.set(false);
    this.sheetOpen.set(false);
    this.phase.set('intro');
    if (wasWaiting) this.endWaiting();
    if (wasWaiting || !prove) this.showDone();
    if (wasWaiting && prove && this.proofsLeft > 0) {
      this.proofsLeft -= 1;
      void this.prove();
    } else {
      // Sem aviso à espera não há o que provar: a prova armada no toque não fica para um aceite de outro aparelho.
      this.proofsLeft = 0;
    }
  }

  /** A continuação do toque: um pedido de lista que, depois do aceite, prova a permissão para os atalhos. */
  private async prove(): Promise<void> {
    try {
      await this.api.refreshShortcuts();
    } catch (error) {
      // Se a TV voltar a pedir (aceitou sem marcar Sempre permitir), o estado `pending` traz o recado de novo.
      if (describeFailure(error).kind === 'adb-permission') this.needs.set(true);
    }
  }

  private startWaiting(): void {
    this.stopWaiting();
    this.waiting.set(true);
    this.done.set(false);
    this.pollTimer = setInterval(() => void this.poll(), ADB_WAIT_POLL_MS);
    this.expireTimer = setTimeout(() => this.expire(), ADB_WAIT_MS);
  }

  /** Com o fluxo de eventos parado (TV Livre, aba em segundo plano) o estado se confere por conta própria. */
  private async poll(): Promise<void> {
    try {
      const state = await this.api.state();
      this.observe(state.adbPermission, state.adbPermissionReason);
    } catch {
      // sem rede agora: a próxima conferência (ou o fim do prazo) resolve
    }
  }

  private endWaiting(): void {
    this.stopWaiting();
    this.waiting.set(false);
  }

  private stopWaiting(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.expireTimer);
    this.pollTimer = this.expireTimer = undefined;
    this.sawPending = false;
  }

  /** O prazo do aceite acabou sem a TV aceitar: a folha volta, agora dizendo isso (foi um pedido da pessoa). */
  private expire(): void {
    if (!this.waiting()) return;
    this.proofsLeft = 0; // sem aceite não há o que provar
    this.endWaiting();
    this.needs.set(true);
    this.open('expired');
  }

  /** Confere, algumas vezes, se o agente conta o aviso na TV (`pending`); sem contar, a folha fala e nada de recado. */
  private confirmPrompt(onUnconfirmed?: () => void): void {
    this.stopConfirming();
    this.confirming = true;
    const attempt = async (left: number): Promise<void> => {
      let value: AdbPermission | null | undefined;
      let read = true;
      try {
        const state = await this.api.state();
        value = state.adbPermission;
        this.observe(value, state.adbPermissionReason);
      } catch {
        read = false; // sem leitura agora: tenta de novo até acabarem as vezes
      }
      if (!this.confirming) return; // `pending`, `granted` ou outra saída já resolveu
      if (read && value == null) {
        // O agente não conta o estado (anterior a este campo): não há como conferir, vale o recado.
        this.stopConfirming();
        this.sheetOpen.set(false);
        if (!this.waiting()) this.startWaiting();
        return;
      }
      if (left > 1) {
        this.confirmTimer = setTimeout(() => void attempt(left - 1), ADB_CONFIRM_POLL_MS);
        return;
      }
      this.stopConfirming();
      this.unconfirmed(onUnconfirmed);
    };
    void attempt(ADB_CONFIRM_TRIES);
  }

  private stopConfirming(): void {
    this.confirming = false;
    clearTimeout(this.confirmTimer);
    this.confirmTimer = undefined;
  }

  /** O pedido não mostrou aviso na TV: a folha diz isso, ou, se ela não pode abrir agora, quem chamou mostra o erro. */
  private unconfirmed(onUnconfirmed?: () => void): void {
    this.needs.set(true);
    if (this.hosts > 0 && !this.blockedByModal()) {
      this.open('noprompt');
      return;
    }
    this.sheetOpen.set(false);
    this.phase.set('intro');
    onUnconfirmed?.();
  }

  private dismissalKey(): string {
    return this.selection.scope() ?? '_';
  }

  /** "Agora não" ainda vale para esta TV (guardado no aparelho por 24 h)? */
  private isDismissed(): boolean {
    try {
      const raw = this.doc.defaultView?.localStorage.getItem(ADB_DISMISSED_KEY);
      const stored: unknown = raw ? JSON.parse(raw) : {};
      const at = (stored as Record<string, unknown> | null)?.[this.dismissalKey()];
      return typeof at === 'number' && Date.now() - at >= 0 && Date.now() - at < ADB_DISMISS_MS;
    } catch {
      return false;
    }
  }

  private rememberDismissal(): void {
    try {
      const storage = this.doc.defaultView?.localStorage;
      if (!storage) return;
      let stored: object = {};
      try {
        const parsed: unknown = JSON.parse(storage.getItem(ADB_DISMISSED_KEY) ?? '{}');
        if (parsed && typeof parsed === 'object') stored = parsed;
      } catch {
        // o que estava guardado não presta: recomeça
      }
      storage.setItem(
        ADB_DISMISSED_KEY,
        JSON.stringify({ ...stored, [this.dismissalKey()]: Date.now() }),
      );
    } catch {
      // sem armazenamento: o "Agora não" vale só até recarregar
    }
  }

  /** O agente apagou o registro (outro aparelho no endereço, no pareamento novo): a pessoa fica sabendo, uma vez. */
  private tellIfCleared(value: AdbPermission | null | undefined, reason?: string | null): void {
    if (value !== 'missing' || reason !== ADB_CLEARED_REASON) {
      if (value) this.clearedTold = false;
      return;
    }
    if (this.clearedTold) return;
    this.clearedTold = true;
    clearTimeout(this.clearedTimer);
    this.cleared.set(true);
    this.clearedTimer = setTimeout(() => this.cleared.set(false), ADB_CLEARED_MS);
  }

  private showDone(): void {
    clearTimeout(this.doneTimer);
    this.done.set(true);
    this.doneTimer = setTimeout(() => this.done.set(false), ADB_DONE_MS);
  }

  /** Há um painel que bloqueia o resto da tela: a folha abriria atrás dele, sem poder ser tocada. */
  private blockedByModal(): boolean {
    try {
      return this.doc.querySelector('dialog:modal') !== null;
    } catch {
      return this.doc.querySelector('dialog[open]') !== null;
    }
  }
}
