import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { problemOf } from '../../core/auth/api-problem';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { SessionState } from '../../core/session/session-state';
import { ConnectSheet } from './connect-sheet';
import { DeviceAgent, DevicesApi } from './devices-api';
import { PairOutcome, PairSheet } from './pair-sheet';
import { formatCodeInput } from './pairing-code';
import { isWindowsPc } from './windows-pc';

/** Parâmetro do endereço que o QR do agente traz (`?codigo=XXXX-XXXX`). */
const CODE_PARAM = 'codigo';

/**
 * Aparelhos: lista dos agentes pareados, pareamento por código (com passkey), recusa de código e revogação.
 * Escrita nunca passa pela fila offline: sem rede, os botões ficam desabilitados e a tela explica.
 *
 * O QR que o agente mostra no PC abre esta tela com o código no endereço: a folha de aprovação já sobe com ele
 * preenchido e o parâmetro sai do endereço na hora (o código não fica no histórico nem em cópia do link). Quem não
 * pode aprovar (convidado) vê só o aviso, sem lista nem folha. Em PC com Windows há ainda a folha "Conectar este PC".
 */
@Component({
  selector: 'app-devices-page',
  imports: [RouterLink, PairSheet, ConnectSheet],
  templateUrl: './devices.page.html',
  styleUrl: './devices.page.css',
})
export class DevicesPage {
  private readonly api = inject(DevicesApi);
  private readonly connectivity = inject(ConnectivityService);
  private readonly session = inject(SessionState);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly online = this.connectivity.online;
  protected readonly agents = signal<readonly DeviceAgent[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly pairing = signal(false);
  protected readonly connecting = signal(false);
  /** Código vindo do endereço (já no formato da tela) para a folha de aprovação. */
  protected readonly linkedCode = signal('');
  /** A API só deixa o dono listar e aprovar; o convidado que chega pelo QR vê um aviso no lugar. */
  protected readonly canManage = !this.session.isGuest();
  /** O conector só existe para Windows: nos outros aparelhos a tela diz isso em vez de oferecer o download. */
  protected readonly windowsPc = isWindowsPc(navigator);
  protected readonly revokingId = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly messageIsError = signal(false);
  protected readonly dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' });

  constructor() {
    if (this.canManage) void this.load();
    // Assina em vez de ler uma vez: com o app já aberto nesta tela, um novo QR muda só o endereço.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const raw = params.get(CODE_PARAM);
      if (raw === null) return;
      this.dropCodeFromUrl();
      if (this.canManage && raw.trim()) this.openPair(formatCodeInput(raw));
    });
  }

  protected pairedAt(agent: DeviceAgent): string {
    return $localize`:@@devices.paired-at:Pareado em ${this.dateFormat.format(new Date(agent.createdAt))}:date:`;
  }

  protected lastSeen(agent: DeviceAgent): string {
    return agent.lastSeenAt
      ? $localize`:@@devices.last-seen:Último uso em ${this.dateFormat.format(new Date(agent.lastSeenAt))}:date:`
      : $localize`:@@devices.never-seen:Sem uso registrado`;
  }

  protected platform(agent: DeviceAgent): string {
    return $localize`:@@devices.platform:Sistema: ${agent.platform}:platform:`;
  }

  protected revokeLabel(agent: DeviceAgent): string {
    return $localize`:@@devices.revoke-label:Revogar ${agent.name}:name:`;
  }

  protected revokeQuestion(agent: DeviceAgent): string {
    return $localize`:@@devices.revoke-question:Revogar o ${agent.name}:name:? Ele para de receber comandos na hora.`;
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      this.agents.set(await this.api.list());
    } catch {
      this.loadFailed.set(true);
    }
  }

  protected openPair(code = ''): void {
    this.revokingId.set(null);
    this.say(null);
    this.connecting.set(false);
    this.linkedCode.set(code);
    this.pairing.set(true);
  }

  protected openConnect(): void {
    this.revokingId.set(null);
    this.say(null);
    this.connecting.set(true);
  }

  /** Tira o código do endereço sem empilhar histórico: voltar não reabre a folha com um código já usado. */
  private dropCodeFromUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [CODE_PARAM]: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected closePair(): void {
    this.pairing.set(false);
  }

  protected async onPaired(outcome: PairOutcome): Promise<void> {
    this.pairing.set(false);
    if (outcome.kind === 'denied') {
      this.say($localize`:@@devices.denied:Código recusado. Nenhum aparelho foi pareado.`, false);
      return;
    }
    const name = outcome.name;
    this.say(
      name
        ? $localize`:@@devices.approved-named:Aparelho ${name}:name: pareado.`
        : $localize`:@@devices.approved:Aparelho pareado.`,
      false,
    );
    await this.load();
  }

  protected askRevoke(agent: DeviceAgent): void {
    this.say(null);
    this.revokingId.set(agent.id);
  }

  protected async confirmRevoke(agent: DeviceAgent): Promise<void> {
    if (this.busy() || !this.online()) return;
    this.busy.set(true);
    try {
      await this.api.revoke(agent.id);
      this.agents.update(
        (list) =>
          list?.map((item) => (item.id === agent.id ? { ...item, revoked: true } : item)) ?? null,
      );
      this.revokingId.set(null);
      this.say($localize`:@@devices.revoked:Aparelho revogado.`, false);
    } catch (error) {
      this.revokingId.set(null);
      const problem = problemOf(error);
      this.say(
        problem?.isNetwork
          ? $localize`:@@devices.network:Sem conexão com o servidor. Tente de novo.`
          : $localize`:@@devices.revoke-failed:Não foi possível revogar agora. Tente de novo.`,
        true,
      );
    } finally {
      this.busy.set(false);
    }
  }

  private say(text: string | null, isError = false): void {
    this.message.set(text);
    this.messageIsError.set(isError);
  }
}
