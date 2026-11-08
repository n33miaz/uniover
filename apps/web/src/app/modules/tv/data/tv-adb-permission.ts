import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { TvApi } from './tv-api';
import { describeFailure } from './tv-errors';
import type { AdbPermission } from './tv-types';

/** De quanto em quanto tempo se confere o estado enquanto o aviso está na TV, e por quanto tempo no máximo. */
export const ADB_WAIT_POLL_MS = 3000;
/** O agente espera o aceite por 90 s: a espera aqui passa um pouco disso, para o fim vir dele e não do relógio. */
export const ADB_WAIT_MS = 100_000;
/** Quanto tempo o "Pronto" fica à vista. */
export const ADB_DONE_MS = 4000;

/** Em que ponto a folha "Liberar na TV" está. */
export type AdbSheetPhase = 'intro' | 'asking' | 'unreachable' | 'expired' | 'failed';

/**
 * A permissão do ADB na TV vista da tela do controle (e do TV Livre). O agente nunca abre o aviso do ADB sozinho: só um
 * toque da pessoa o faz aparecer na TV. Quando algo que precisa do ADB falha por falta de permissão, ou o agente conta
 * que ela falta (`missing`), a tela abre uma folha curta, que **não bloqueia** o controle, com "Pedir na TV". Enquanto o
 * aviso está na TV (`pending`) um recado fixo no celular diz o que fazer ali. Toda vez que o aviso aparece na TV o
 * celular mostra esse recado, também quando foi um caminho automático que o abriu.
 *
 * Sem insistir: "Agora não" cala a folha até o próximo abrir do app (a falta continua à vista nos atalhos, por `needs`, e
 * uma falha seguinte vira só um aviso curto). A folha também não abre sobre um painel que já bloqueia a tela.
 *
 * Quem aceita o aviso na TV deixa a permissão como `granted`, mas só um toque da pessoa a prova (o agente não conecta
 * sozinho antes disso). Por isso, ao ver o aceite, esta classe faz **um** pedido de lista a mais, a continuação do mesmo
 * toque de "Pedir na TV": é ele que prova a permissão e libera os atalhos.
 */
@Injectable({ providedIn: 'root' })
export class TvAdbPermission {
  private readonly api = inject(TvApi);
  private readonly doc = inject(DOCUMENT);

  /** O ADB da TV está pedindo permissão: os atalhos mostram um sinal discreto. */
  readonly needs = signal(false);
  readonly sheetOpen = signal(false);
  readonly phase = signal<AdbSheetPhase>('intro');
  /** O aviso está na TV, esperando o aceite: o recado fixo aparece no celular. */
  readonly waiting = signal(false);
  /** A TV acabou de aceitar: um "Pronto" curto. */
  readonly done = signal(false);
  readonly asking = computed(() => this.phase() === 'asking');

  private dismissed = false;
  /** Uma ação foi recusada enquanto um painel bloqueava a tela: a folha abre quando ele fechar. */
  private deferred = false;
  /** Quantas telas hospedam a folha agora (sem nenhuma, nada se mostraria: quem chama mostra o erro curto). */
  private hosts = 0;
  private sawPending = false;
  private proofsLeft = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private expireTimer: ReturnType<typeof setTimeout> | undefined;
  private doneTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Uma ação que precisa do ADB falhou por falta de permissão. Devolve `true` se a tela já cuida disso (a folha abriu, ou
   * o aviso já está na TV) e `false` se quem chamou deve mostrar o erro curto (a pessoa disse "Agora não", ou há um painel
   * bloqueando a tela e a folha ficaria atrás dele).
   */
  denied(): boolean {
    this.needs.set(true);
    if (this.hosts === 0) return false;
    if (this.waiting() || this.sheetOpen()) return true;
    if (this.dismissed) return false;
    if (this.blockedByModal()) {
      this.deferred = true;
      return false;
    }
    this.open('intro');
    return true;
  }

  /**
   * O pedido da própria pessoa (Atualizar lista, uma ação do TV Livre) deixou o aviso na TV: não há o que perguntar, só
   * esperar o aceite, e depois provar a permissão com mais um pedido. Devolve `false` se nenhuma tela mostraria o recado
   * (quem chama mostra o erro).
   */
  prompted(): boolean {
    this.needs.set(true);
    if (this.hosts === 0) return false;
    this.sheetOpen.set(false);
    this.proofsLeft = 1;
    // O estado `pending` pode chegar pelo fluxo antes da resposta do pedido: a espera que ele já abriu segue como está.
    if (!this.waiting()) this.startWaiting();
    return true;
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
    if (this.needs() && this.hosts > 0 && !this.dismissed) this.open('intro');
  }

  /** Algo que usa o ADB deu certo: a permissão está valendo. */
  confirmed(): void {
    this.needs.set(false);
    if (this.waiting()) this.endWaiting();
    this.sheetOpen.set(false);
  }

  /**
   * O estado que o agente conta (`null`: não diz). `missing` abre a folha na hora (uma vez por abertura do app), `pending`
   * mostra o recado, `granted` fecha tudo.
   */
  observe(value: AdbPermission | null | undefined): void {
    switch (value) {
      case 'granted':
        this.granted();
        return;
      case 'pending':
        this.needs.set(true);
        this.sheetOpen.set(false);
        if (!this.waiting()) this.startWaiting();
        this.sawPending = true;
        return;
      case 'missing':
        this.needs.set(true);
        // Só o fim do aviso (visto como `pending` antes) é o "ninguém aceitou"; um `missing` anterior ao pedido não é.
        if (this.waiting() && this.sawPending) this.expire();
        else if (!this.waiting()) this.denied();
        return;
      default:
        return;
    }
  }

  /** "Pedir na TV": faz o pedido da pessoa que mostra o aviso na TV (o mesmo de Atualizar lista). */
  async ask(): Promise<void> {
    if (this.asking()) return;
    this.phase.set('asking');
    this.proofsLeft = 1;
    try {
      await this.api.refreshShortcuts();
      // A TV já guardava a permissão: não houve aviso, e o pedido já a provou.
      this.granted(false);
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.kind === 'adb-permission') {
        // O aviso está na TV: a folha sai, o recado fica, e o aceite chega pelo estado.
        this.prompted();
      } else if (failure.kind === 'agent-offline' || failure.kind === 'agent-reconnecting') {
        this.phase.set('unreachable');
      } else {
        this.phase.set('failed');
      }
    }
  }

  /** "Agora não": cala a folha até o próximo abrir do app. */
  dismiss(): void {
    this.dismissed = true;
    this.sheetOpen.set(false);
    this.phase.set('intro');
  }

  /** O que sobrou ao sair da tela: tempos e recado. */
  reset(): void {
    this.deferred = false;
    this.stopWaiting();
    clearTimeout(this.doneTimer);
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
    this.needs.set(false);
    this.sheetOpen.set(false);
    this.phase.set('intro');
    if (wasWaiting) this.endWaiting();
    if (wasWaiting || !prove) this.showDone();
    if (wasWaiting && prove && this.proofsLeft > 0) {
      this.proofsLeft -= 1;
      void this.prove();
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
      this.observe(state.adbPermission);
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
    this.endWaiting();
    this.needs.set(true);
    this.open('expired');
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
