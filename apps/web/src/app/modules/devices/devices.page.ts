import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { isStepUpRequired, problemOf } from '../../core/auth/api-problem';
import { canUseModule } from '../../core/auth/guest-home';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { SessionState } from '../../core/session/session-state';
import { ConnectSheet } from './connect-sheet';
import { AgentLogSheet } from './agent-log-sheet';
import { AgentAlert, DeviceAgent, DeviceTv, DevicesApi, MaintenanceAction } from './devices-api';
import { GuestPairSheet } from './guest-pair-sheet';
import { PairOutcome, PairSheet } from './pair-sheet';
import { formatCodeInput } from './pairing-code';
import { CONNECTOR_URL, isWindowsPc } from './windows-pc';

/** Parâmetro do endereço que o QR do agente traz (`?codigo=XXXX-XXXX`). */
const CODE_PARAM = 'codigo';

/** Quantos caracteres do commit instalado a tela mostra. */
const SHORT_BUILD = 7;

/** Agente de uma versão que não sabe fazer o pedido: ele se atualiza sozinho em algumas horas. */
const outdatedText = () =>
  $localize`:@@devices.outdated:Este computador ainda roda uma versão do agente sem essa função. Atualize o agente: ele se atualiza sozinho em algumas horas, e depois é só tentar de novo.`;

/**
 * Dispositivos: lista dos agentes pareados, pareamento por código (com passkey), recusa de código e revogação.
 * Escrita nunca passa pela fila offline: sem rede, os botões ficam desabilitados e a tela explica.
 *
 * O QR que o agente mostra no PC abre esta tela com o código no endereço: a folha de aprovação já sobe com ele
 * preenchido e o parâmetro sai do endereço na hora (o código não fica no histórico nem em cópia do link). Quem não
 * pode aprovar para os outros (convidado) não vê lista: se a conta dele tem a TV, baixa o conector e aprova o PC dele como
 * a PRÓPRIA TV (folha própria, com a senha reconfirmada); sem a TV vê só o aviso. Em PC com Windows há ainda a folha "Conectar este PC".
 *
 * Manutenção remota (só o administrador, que é quem chega até aqui): cada aparelho mostra a versão instalada, o sistema,
 * a TV e o último contato, e oferece "Ver registro" (folha com o fim do registro do agente), "Atualizar agora" e
 * "Reiniciar o agente". As duas últimas pedem uma confirmação na tela e a passkey (o interceptador abre o diálogo).
 */
@Component({
  selector: 'app-devices-page',
  imports: [PairSheet, ConnectSheet, AgentLogSheet, GuestPairSheet],
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
  /** Avisos de queda ainda não vistos; falhar em lê-los nunca atrapalha a lista. */
  protected readonly alerts = signal<readonly AgentAlert[]>([]);
  protected readonly dismissingAlertId = signal<string | null>(null);
  /** As TVs e o computador de cada uma; sem elas a seção some. */
  protected readonly tvs = signal<readonly DeviceTv[]>([]);
  protected readonly pairing = signal(false);
  protected readonly connecting = signal(false);
  /** Código vindo do endereço (já no formato da tela) para a folha de aprovação. */
  protected readonly linkedCode = signal('');
  /** A API só deixa o dono listar e aprovar; o convidado que chega pelo QR vê um aviso no lugar. */
  protected readonly canManage = !this.session.isGuest();
  /** O convidado com a TV também baixa o conector (aprovar continua só do administrador). */
  protected readonly canDownload = canUseModule(
    this.session.role(),
    this.session.knownPermissions(),
    'tv',
  );
  /** O convidado com a TV aprova o PC dele sozinho (a API confere a permissão, a senha recente e o limite). */
  protected readonly canPairSelf = !this.canManage && this.canDownload;
  protected readonly guestPairing = signal(false);
  protected readonly connectorUrl = CONNECTOR_URL;
  /** O conector só existe para Windows: nos outros aparelhos a tela diz isso em vez de oferecer o download. */
  protected readonly windowsPc = isWindowsPc(navigator);
  protected readonly revokingId = signal<string | null>(null);
  /** Computadores com a manutenção aberta: a dobra sobrevive à confirmação em linha, que troca o bloco inteiro. */
  protected readonly maintenanceOpen = signal<ReadonlySet<string>>(new Set());
  /** O pedido de atualizar ou reiniciar que espera a confirmação do dono, ou que está em andamento. */
  protected readonly maintaining = signal<{ id: string; action: MaintenanceAction } | null>(null);
  /** O aparelho cujo registro está aberto na folha. */
  protected readonly viewingLog = signal<DeviceAgent | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly messageIsError = signal(false);
  protected readonly dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' });
  protected readonly contactFormat = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  constructor() {
    if (this.canManage) void this.load();
    // Assina em vez de ler uma vez: com o app já aberto nesta tela, um novo QR muda só o endereço.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const raw = params.get(CODE_PARAM);
      if (raw === null) return;
      this.dropCodeFromUrl();
      if (this.canManage && raw.trim()) this.openPair(formatCodeInput(raw));
      else if (this.canPairSelf && raw.trim()) this.openGuestPair(formatCodeInput(raw));
    });
  }

  protected pairedAt(agent: DeviceAgent): string {
    return $localize`:@@devices.paired-at:Pareado em ${this.dateFormat.format(new Date(agent.createdAt))}:date:`;
  }

  protected lastSeen(agent: DeviceAgent): string {
    if (!agent.lastSeenAt) {
      return $localize`:@@devices.never-seen:Sem contato registrado`;
    }

    const elapsed = Math.max(0, Date.now() - new Date(agent.lastSeenAt).getTime());
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) {
      return $localize`:@@devices.last-seen.now:Visto agora`;
    }
    if (minutes < 60) {
      return $localize`:@@devices.last-seen.minutes:Visto há ${minutes}:count: min`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return $localize`:@@devices.last-seen.hours:Visto há ${hours}:count: h`;
    }

    const days = Math.floor(hours / 24);
    return days === 1
      ? $localize`:@@devices.last-seen.day:Visto há 1 dia`
      : $localize`:@@devices.last-seen.days:Visto há ${days}:count: dias`;
  }

  protected platform(agent: DeviceAgent): string {
    const system = agent.os ?? agent.platform;
    return $localize`:@@devices.platform:Sistema: ${system}:platform:`;
  }

  /** "Versão 0.1.0 · 3f2a9c1": o pacote e o começo do commit instalado (o que diz de fato qual código roda). */
  protected version(agent: DeviceAgent): string | null {
    if (!agent.agentVersion) return null;
    const build = agent.agentBuild ? agent.agentBuild.slice(0, SHORT_BUILD) : null;
    const version = agent.agentVersion;
    return build
      ? $localize`:@@devices.version-build:Versão ${version}:version: · ${build}:build:`
      : $localize`:@@devices.version:Versão ${version}:version:`;
  }

  protected tv(agent: DeviceAgent): string | null {
    if (!agent.tvKind && !agent.tvHost) return null;
    const kind =
      agent.tvKind === 'samsung'
        ? $localize`:@@devices.tv-samsung:Samsung`
        : agent.tvKind === 'android'
          ? $localize`:@@devices.tv-android:Android TV`
          : $localize`:@@devices.tv-generic:TV`;
    const host = agent.tvHost;
    return host
      ? $localize`:@@devices.tv-info:${kind}:kind: · ${host}:host:`
      : $localize`:@@devices.tv-kind:${kind}:kind:`;
  }

  protected toggleMaintenance(agent: DeviceAgent, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.maintenanceOpen.update((current) => {
      if (current.has(agent.id) === open) return current;
      const next = new Set(current);
      if (open) next.add(agent.id);
      else next.delete(agent.id);
      return next;
    });
  }

  protected tvSummary(agent: DeviceAgent): string {
    return this.tv(agent) ?? $localize`:@@devices.summary.no-tv:Sem TV vinculada`;
  }

  /**
   * O estado da auto-atualização em uma frase. Agente conectado que nunca contou isso é de uma versão antiga: a tela diz
   * que a versão é desconhecida e pede para atualizar. Sem ter falado nunca (sem versão), não há o que dizer.
   */
  protected updateState(agent: DeviceAgent): string | null {
    const update = agent.update;
    if (!update) {
      return agent.agentVersion
        ? $localize`:@@devices.update.unknown:Versão desconhecida: atualize o agente`
        : null;
    }
    const when = this.updateTime(update.checkedAt);
    switch (update.state) {
      case 'current':
        return $localize`:@@devices.update.current:Atualizado`;
      case 'updating':
        return $localize`:@@devices.update.updating:Atualizando…`;
      case 'pending':
        return update.nextCheckAt
          ? $localize`:@@devices.update.pending-next:Atualização pendente: próxima checagem em ${this.updateTime(update.nextCheckAt)}:next:`
          : $localize`:@@devices.update.pending:Atualização pendente`;
      case 'failed': {
        const reason = update.reason ?? $localize`:@@devices.update.no-reason:sem detalhe`;
        return when
          ? $localize`:@@devices.update.failed-at:Falhou: ${reason}:reason: (${when}:time:)`
          : $localize`:@@devices.update.failed:Falhou: ${reason}:reason:`;
      }
      case 'blocked':
        return $localize`:@@devices.update.blocked:Versão nova bloqueada: ela caiu repetidamente`;
      case 'rolled_back':
        return $localize`:@@devices.update.rolled-back:Voltou para a versão anterior`;
      case 'unchecked':
        return $localize`:@@devices.update.unchecked:Aguardando a primeira checagem`;
      default:
        return null;
    }
  }

  /** Falha e bloqueio pedem o chip de erro; pendência e volta, o de aviso; versão desconhecida também. */
  protected updateTone(agent: DeviceAgent): 'bad' | 'warn' | 'ok' | '' {
    switch (agent.update?.state) {
      case 'failed':
      case 'blocked':
        return 'bad';
      case 'pending':
      case 'updating':
      case 'rolled_back':
        return 'warn';
      case 'current':
        return 'ok';
      default:
        return agent.update ? '' : 'warn';
    }
  }

  /** "Instalada: 3f2a9c1 em 20 de out. de 2026, 09:15". */
  protected installed(agent: DeviceAgent): string | null {
    const update = agent.update;
    if (!update?.installedSha) return null;
    const sha = update.installedSha.slice(0, SHORT_BUILD);
    const when = this.updateTime(update.installedAt);
    return when
      ? $localize`:@@devices.update.installed-at:Instalada: ${sha}:sha: em ${when}:time:`
      : $localize`:@@devices.update.installed:Instalada: ${sha}:sha:`;
  }

  /** A mais nova que a última checagem viu; igual à instalada, a tela diz que não há nada novo. */
  protected newest(agent: DeviceAgent): string | null {
    const update = agent.update;
    if (!update?.latestSha) return null;
    if (update.latestSha === update.installedSha) {
      return $localize`:@@devices.update.newest-same:Mais nova disponível: a mesma instalada`;
    }
    const sha = update.latestSha.slice(0, SHORT_BUILD);
    return $localize`:@@devices.update.newest:Mais nova disponível: ${sha}:sha:`;
  }

  /** O que a última checagem concluiu, com a hora. */
  protected lastCheck(agent: DeviceAgent): string | null {
    const update = agent.update;
    const when = this.updateTime(update?.checkedAt);
    if (!update || !when) return null;
    switch (update.state) {
      case 'failed':
        return $localize`:@@devices.update.check-failed:Última checagem: ${when}:time:, falhou`;
      case 'updating':
        return $localize`:@@devices.update.check-running:Checagem em andamento desde ${when}:time:`;
      case 'blocked':
        return $localize`:@@devices.update.check-blocked:Última checagem: ${when}:time:, versão bloqueada`;
      case 'rolled_back':
        return $localize`:@@devices.update.check-rolled-back:Voltou à versão anterior em ${when}:time:`;
      case 'pending':
        return $localize`:@@devices.update.check-pending:Última checagem: ${when}:time:, há versão nova`;
      case 'current':
        return $localize`:@@devices.update.check-current:Última checagem: ${when}:time:, sem novidade`;
      default:
        return $localize`:@@devices.update.check:Última checagem: ${when}:time:`;
    }
  }

  /** A volta à versão anterior e a versão que ficou de fora, quando houve. */
  protected rollbackNote(agent: DeviceAgent): string | null {
    const update = agent.update;
    if (!update?.rolledBack) return null;
    const blocked = update.blockedSha?.slice(0, SHORT_BUILD);
    return blocked
      ? $localize`:@@devices.update.rolled-back-blocked:Houve volta à versão anterior; a versão ${blocked}:sha: não será instalada de novo.`
      : $localize`:@@devices.update.rolled-back-note:Houve volta à versão anterior.`;
  }

  private updateTime(value: string | null | undefined): string | null {
    return value ? this.contactFormat.format(new Date(value)) : null;
  }

  protected connection(agent: DeviceAgent): string {
    return agent.connected
      ? $localize`:@@devices.connected:Conectado agora`
      : $localize`:@@devices.disconnected:Desconectado`;
  }

  protected viewLogLabel(agent: DeviceAgent): string {
    return $localize`:@@devices.view-log-label:Ver registro de ${agent.name}:name:`;
  }

  protected updateLabel(agent: DeviceAgent): string {
    return $localize`:@@devices.update-label:Atualizar agora: ${agent.name}:name:`;
  }

  protected restartLabel(agent: DeviceAgent): string {
    return $localize`:@@devices.restart-label:Reiniciar o agente de ${agent.name}:name:`;
  }

  protected rollbackLabel(agent: DeviceAgent): string {
    return $localize`:@@devices.rollback-label:Voltar para a versão anterior de ${agent.name}:name:`;
  }

  protected maintenanceQuestion(agent: DeviceAgent, action: MaintenanceAction): string {
    if (action === 'rollback') {
      const previous = agent.update?.previousSha?.slice(0, SHORT_BUILD) ?? '';
      return $localize`:@@devices.rollback-question:Voltar o agente de ${agent.name}:name: para a versão anterior (${previous}:sha:)? A versão de agora fica bloqueada e ele reinicia sozinho em até 15 segundos.`;
    }
    return action === 'update'
      ? $localize`:@@devices.update-question:Atualizar o agente de ${agent.name}:name: agora? Se houver versão nova, ele reinicia sozinho em até 15 segundos.`
      : $localize`:@@devices.restart-question:Reiniciar o agente de ${agent.name}:name:? Ele sai do ar por alguns segundos e volta sozinho.`;
  }

  /** O registro: sem a capacidade (agente antigo) a tela já explica, sem gastar um pedido que a API recusaria. */
  protected openLog(agent: DeviceAgent): void {
    this.say(null);
    this.revokingId.set(null);
    this.maintaining.set(null);
    if (!agent.canReadLogs) {
      this.say(outdatedText(), true);
      return;
    }
    this.viewingLog.set(agent);
  }

  protected askMaintenance(agent: DeviceAgent, action: MaintenanceAction): void {
    this.say(null);
    this.revokingId.set(null);
    if (!agent.canMaintain || (action === 'rollback' && !agent.canRollback)) {
      this.maintaining.set(null);
      this.say(outdatedText(), true);
      return;
    }
    this.maintaining.set({ id: agent.id, action });
  }

  protected async confirmMaintenance(agent: DeviceAgent): Promise<void> {
    const pending = this.maintaining();
    if (!pending || pending.id !== agent.id || this.busy() || !this.online()) return;
    this.busy.set(true);
    try {
      await this.api.maintain(agent.id, pending.action);
      this.maintaining.set(null);
      this.say(this.sentText(pending.action), false);
    } catch (error) {
      this.maintaining.set(null);
      this.say(this.maintenanceError(error), true);
    } finally {
      this.busy.set(false);
    }
  }

  private sentText(action: MaintenanceAction): string {
    switch (action) {
      case 'update':
        return $localize`:@@devices.update-sent:Pedido de atualização enviado. Se houver versão nova, o agente reinicia sozinho em até 15 segundos.`;
      case 'rollback':
        return $localize`:@@devices.rollback-sent:Pedido enviado. O agente volta para a versão anterior e reinicia sozinho em até 15 segundos.`;
      default:
        return $localize`:@@devices.restart-sent:Pedido de reinício enviado. O agente volta sozinho em alguns segundos.`;
    }
  }

  private maintenanceError(error: unknown): string {
    const problem = problemOf(error);
    if (problem && isStepUpRequired(problem)) {
      return $localize`:@@devices.maintenance.unconfirmed:A ação não foi confirmada com a passkey. Nada foi feito.`;
    }
    if (problem?.isNetwork) {
      return $localize`:@@devices.network:Sem conexão com o servidor. Tente de novo.`;
    }
    switch (problem?.kind) {
      case 'agent-outdated':
        return outdatedText();
      case 'no-previous-version':
        return $localize`:@@devices.maintenance.no-previous:Este computador não guardou uma versão anterior para voltar.`;
      case 'agent-offline':
        return $localize`:@@devices.maintenance.offline:O agente está desconectado. Ligue o PC e tente de novo.`;
      case 'agent-timeout':
        return $localize`:@@devices.maintenance.timeout:O agente não respondeu a tempo. Tente de novo.`;
      default:
        return problem?.status === 429
          ? $localize`:@@devices.maintenance.rate-limited:Muitos pedidos seguidos. Espere um pouco e tente de novo.`
          : $localize`:@@devices.maintenance.failed:Não foi possível fazer isso agora. Tente de novo.`;
    }
  }

  protected revokeLabel(agent: DeviceAgent): string {
    return $localize`:@@devices.revoke-label:Revogar ${agent.name}:name:`;
  }

  protected revokeQuestion(agent: DeviceAgent): string {
    return $localize`:@@devices.revoke-question:Revogar o ${agent.name}:name:? Ele para de receber comandos na hora.`;
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    void this.loadExtras();
    try {
      this.agents.set(await this.api.list());
    } catch {
      this.loadFailed.set(true);
    }
  }

  /** Avisos e TVs são acréscimos: se falharem, a lista de computadores segue como está. */
  private async loadExtras(): Promise<void> {
    // `then` captura também o erro síncrono de um cliente incompleto: ler o acréscimo nunca derruba a tela.
    const [alerts, tvs] = await Promise.allSettled([
      Promise.resolve().then(() => this.api.alerts()),
      Promise.resolve().then(() => this.api.tvs()),
    ]);
    this.alerts.set(alerts.status === 'fulfilled' ? alerts.value : []);
    this.tvs.set(tvs.status === 'fulfilled' ? tvs.value : []);
  }

  protected alertTitle(alert: AgentAlert): string {
    const name = alert.agentName;
    if (alert.kind === 'update_failed') {
      // Título curto, que cabe numa linha ao lado do botão; o nome do computador vai na linha de baixo.
      return $localize`:@@devices.alert.update-failed:Falha de Atualização`;
    }
    return alert.recoveredAt
      ? $localize`:@@devices.alert.back:${name}:name: voltou`
      : $localize`:@@devices.alert.down:${name}:name: está sem sinal`;
  }

  protected alertDetail(alert: AgentAlert): string {
    const since = this.contactFormat.format(new Date(alert.recoveredAt ?? alert.detectedAt));
    if (alert.kind === 'update_failed') {
      const name = alert.agentName;
      return $localize`:@@devices.alert.update-failed-at:${name}:name:, em ${since}:time:`;
    }
    return alert.recoveredAt
      ? $localize`:@@devices.alert.back-at:Voltou em ${since}:time:`
      : $localize`:@@devices.alert.down-at:Sem sinal desde ${since}:time:`;
  }

  protected async dismissAlert(alert: AgentAlert): Promise<void> {
    if (this.dismissingAlertId()) return;
    this.dismissingAlertId.set(alert.id);
    try {
      await this.api.markAlertSeen(alert.id);
      this.alerts.update((items) => items.filter((item) => item.id !== alert.id));
    } catch {
      this.say(
        $localize`:@@devices.alert.dismiss-failed:Não foi possível dispensar o aviso agora.`,
        true,
      );
    } finally {
      this.dismissingAlertId.set(null);
    }
  }

  /** O computador que controla a TV, pelo nome (a TV só guarda o identificador dele). */
  protected tvComputer(tv: DeviceTv): string {
    const agent = this.agents()?.find((item) => item.slug === tv.agentSlug);
    return agent
      ? $localize`:@@devices.tv.computer:Computador: ${agent.name}:name:`
      : $localize`:@@devices.tv.no-computer:Sem computador`;
  }

  protected tvState(tv: DeviceTv): string {
    return tv.online
      ? $localize`:@@devices.tv.online:Online`
      : $localize`:@@devices.tv.offline:Sem Conexão`;
  }

  protected openPair(code = ''): void {
    this.revokingId.set(null);
    this.say(null);
    this.connecting.set(false);
    this.linkedCode.set(code);
    this.pairing.set(true);
  }

  protected openGuestPair(code = ''): void {
    this.say(null);
    this.linkedCode.set(code);
    this.guestPairing.set(true);
  }

  protected onGuestPaired(): void {
    this.guestPairing.set(false);
    this.say(
      $localize`:@@devices.guest-paired:Computador conectado. A sua TV já aparece no controle.`,
      false,
    );
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
      this.say(
        $localize`:@@devices.denied:Código recusado. Nenhum dispositivo foi pareado.`,
        false,
      );
      return;
    }
    const name = outcome.name;
    this.say(
      name
        ? $localize`:@@devices.approved-named:Dispositivo ${name}:name: pareado.`
        : $localize`:@@devices.approved:Dispositivo pareado.`,
      false,
    );
    await this.load();
  }

  protected askRevoke(agent: DeviceAgent): void {
    this.say(null);
    this.maintaining.set(null);
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
      this.say($localize`:@@devices.revoked:Dispositivo revogado.`, false);
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
