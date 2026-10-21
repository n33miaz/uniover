import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { problemOf } from '../../core/auth/api-problem';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { SessionState } from '../../core/session/session-state';
import { SettingsGlyph } from './settings-glyph';
import { SystemApi, TvComputer, TvComputerStatus, TvConfig, TvConfigSource } from './system-api';

/** O estado do computador em palavras da pessoa, e o tom do chip que o mostra. */
interface StatusView {
  readonly label: string;
  readonly tone: 'accent' | 'warn' | 'bad' | 'plain';
}

function readStatus(config: TvConfig): TvComputerStatus {
  switch (config.agentStatus) {
    case 'online':
    case 'offline':
    case 'revoked':
      return config.agentStatus;
    default:
      return 'unknown';
  }
}

function readSource(config: TvConfig): TvConfigSource {
  return config.source === 'saved' || config.source === 'environment' ? config.source : 'none';
}

/**
 * Sistema > TV: qual computador controla a TV. O administrador vê o computador de agora (nome, se está ligado e de onde
 * vem a escolha), escolhe outro entre os pareados e salva com a passkey, sem mexer em nada no servidor. Quando o
 * computador atual foi revogado ou não existe, a tela avisa que a TV não responde até haver outra escolha.
 *
 * Só carrega quando se sabe que a conta é do administrador (a rota é dele): quem não é nunca gera essa chamada. Escrita
 * nunca passa pela fila offline: sem rede, o botão fica desabilitado e a tela explica.
 */
@Component({
  selector: 'app-system-tv-section',
  imports: [RouterLink, SettingsGlyph],
  templateUrl: './system-tv-section.html',
  styleUrl: './system-tv-section.css',
})
export class SystemTvSection {
  private readonly api = inject(SystemApi);
  private readonly session = inject(SessionState);
  private readonly connectivity = inject(ConnectivityService);

  protected readonly online = this.connectivity.online;
  protected readonly config = signal<TvConfig | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly selected = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly messageIsError = signal(false);

  protected readonly status = computed<TvComputerStatus>(() => {
    const config = this.config();
    return config ? readStatus(config) : 'unknown';
  });
  protected readonly source = computed<TvConfigSource>(() => {
    const config = this.config();
    return config ? readSource(config) : 'none';
  });
  protected readonly computers = computed<readonly TvComputer[]>(() => this.config()?.agents ?? []);
  protected readonly hasCurrent = computed(() => this.source() !== 'none');

  /** O nome que aparece no cartão: o do computador, ou o que explica que não há um. */
  protected readonly currentName = computed(() => {
    const config = this.config();
    if (!config || !this.hasCurrent()) {
      return $localize`:@@settings.system.tv.none:Nenhum computador escolhido`;
    }
    return config.agentName ?? $localize`:@@settings.system.tv.not-found:Computador não encontrado`;
  });

  protected readonly statusView = computed<StatusView | null>(() => {
    if (!this.config() || !this.hasCurrent()) return null;
    switch (this.status()) {
      case 'online':
        return { label: $localize`:@@settings.system.tv.state-online:Ligado`, tone: 'accent' };
      case 'offline':
        return { label: $localize`:@@settings.system.tv.state-offline:Desligado`, tone: 'plain' };
      case 'revoked':
        return { label: $localize`:@@settings.system.tv.state-revoked:Revogado`, tone: 'bad' };
      default:
        return {
          label: $localize`:@@settings.system.tv.state-unknown:Não encontrado`,
          tone: 'warn',
        };
    }
  });

  /** Sem computador, ou com um revogado ou que nunca foi pareado: a TV não responde. Desligado é só desligado. */
  protected readonly broken = computed(
    () =>
      !!this.config() &&
      (!this.hasCurrent() || this.status() === 'revoked' || this.status() === 'unknown'),
  );

  protected readonly warning = computed(() => {
    if (!this.broken()) return null;
    if (!this.hasCurrent()) {
      return $localize`:@@settings.system.tv.warn-none:Nenhum computador controla a TV. Ela não vai responder até você escolher um computador ou parear um em Aparelhos.`;
    }
    return this.status() === 'revoked'
      ? $localize`:@@settings.system.tv.warn-revoked:Este computador foi revogado. A TV não vai responder até você escolher outro computador ou parear de novo em Aparelhos.`
      : $localize`:@@settings.system.tv.warn-unknown:Este computador não está entre os aparelhos pareados. A TV não vai responder até você escolher outro computador ou parear de novo em Aparelhos.`;
  });

  /** De onde vem a escolha, em uma frase curta (o servidor só entra quando nada foi salvo aqui). */
  protected readonly originText = computed(() => {
    switch (this.source()) {
      case 'saved':
        return $localize`:@@settings.system.tv.origin-saved:Escolhido aqui, no app.`;
      case 'environment':
        return $localize`:@@settings.system.tv.origin-environment:Vem da configuração do servidor. Salve aqui para guardar a escolha no app.`;
      default:
        return null;
    }
  });

  /** Desligado agora não é problema: a TV volta a responder quando o computador ligar. */
  protected readonly offlineHint = computed(() =>
    this.hasCurrent() && this.status() === 'offline'
      ? $localize`:@@settings.system.tv.offline-hint:Está desligado agora. A TV volta a responder quando ele ligar.`
      : null,
  );

  /**
   * Salvar vale quando a escolha mudou, ou quando o valor ainda vem só do servidor (salvar o mesmo computador é o que o
   * guarda no app). O computador revogado nunca está na lista, então não dá para escolhê-lo de novo.
   */
  protected readonly canSave = computed(() => {
    const choice = this.selected();
    const config = this.config();
    if (!choice || !config) return false;
    return choice !== config.agentSlug || this.source() !== 'saved';
  });

  constructor() {
    // Carrega quando há sessão confirmada (também quando uma sessão pendente é confirmada depois) e se sabe que a conta é
    // do administrador: a configuração do sistema é rota de administrador, e quem não é nunca deve gerar essa chamada.
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.config()) === null
      ) {
        untracked(() => void this.load());
      }
    });
  }

  /** O sistema do computador como a pessoa o conhece (a API manda em minúsculas). */
  protected platform(computer: TvComputer): string {
    switch (computer.platform) {
      case 'windows':
        return 'Windows';
      case 'macos':
        return 'macOS';
      case 'linux':
        return 'Linux';
      default:
        return computer.platform.charAt(0).toUpperCase() + computer.platform.slice(1);
    }
  }

  protected computerState(computer: TvComputer): string {
    return computer.online
      ? $localize`:@@settings.system.tv.state-online:Ligado`
      : $localize`:@@settings.system.tv.state-offline:Desligado`;
  }

  protected isCurrent(computer: TvComputer): boolean {
    return this.config()?.agentSlug === computer.slug;
  }

  protected choose(slug: string): void {
    this.selected.set(slug);
    this.say(null);
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      this.apply(await this.api.tvConfig());
    } catch {
      this.loadFailed.set(true);
    }
  }

  protected async save(): Promise<void> {
    const choice = this.selected();
    if (this.busy() || !this.online() || !choice || !this.canSave()) return;
    this.busy.set(true);
    this.say(null);
    try {
      // Sem a confirmação recente com a passkey a API recusa (403) e o interceptador abre o diálogo e repete o pedido.
      const updated = await this.api.bindTvComputer(choice);
      this.apply(updated);
      const name = updated.agentName ?? '';
      this.say(
        name
          ? $localize`:@@settings.system.tv.saved-named:Pronto: agora ${name}:name: controla a TV.`
          : $localize`:@@settings.system.tv.saved:Pronto: a escolha foi salva.`,
        false,
      );
    } catch (error) {
      this.say(this.saveError(error), true);
      // O computador saiu da lista (revogado por outra pessoa, por exemplo): mostra a lista de agora.
      if (problemOf(error)?.status === 400) await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  private apply(config: TvConfig): void {
    this.config.set(config);
    this.loadFailed.set(false);
    // O computador atual já vem escolhido, se ainda está na lista; senão a pessoa precisa escolher.
    const current = config.agents.find((computer) => computer.slug === config.agentSlug);
    const keep = this.selected();
    this.selected.set(
      keep && config.agents.some((computer) => computer.slug === keep)
        ? keep
        : (current?.slug ?? null),
    );
  }

  private say(text: string | null, isError = false): void {
    this.message.set(text);
    this.messageIsError.set(isError);
  }

  private saveError(error: unknown): string {
    const problem = problemOf(error);
    if (problem?.status === 400) {
      return $localize`:@@settings.system.tv.gone:Esse computador não está mais na lista de pareados. A lista foi atualizada: escolha de novo.`;
    }
    if (problem?.status === 403) {
      return $localize`:@@settings.system.tv.unconfirmed:A troca não foi feita: falta a confirmação com a passkey. Se ainda não tem uma, cadastre em Segurança e tente de novo.`;
    }
    if (problem?.status === 429) {
      return $localize`:@@settings.system.tv.rate-limited:Muitas tentativas seguidas. Espere um pouco.`;
    }
    if (problem?.isNetwork) {
      return $localize`:@@settings.system.tv.network:Sem conexão com o servidor. Tente de novo.`;
    }
    return $localize`:@@settings.system.tv.save-failed:Não foi possível salvar agora. Tente de novo.`;
  }
}
