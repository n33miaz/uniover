import { DOCUMENT } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { problemOf } from '../../core/auth/api-problem';
import { SessionState } from '../../core/session/session-state';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import { SettingsGlyph } from './settings-glyph';
import { SystemApi, TvItem } from './system-api';
import { CreatedSiriKey, SiriApi, SiriKey } from './siri-api';
import {
  SIRI_MAX_KEYS,
  SiriAction,
  SiriGroup,
  actionOfCode,
  appAction,
  expiryOptions,
  fixedActions,
} from './siri-model';
import { SiriSteps } from './siri-steps';

const MAX_NAME = 40;

interface Note {
  readonly text: string;
  readonly error: boolean;
}

interface ActionGroup {
  readonly group: SiriGroup;
  readonly title: string;
  readonly actions: readonly SiriAction[];
}

/**
 * Atalhos da Siri (só do administrador): chaves que deixam o app Atalhos do iPhone mandar ordens à TV sem abrir o app.
 * Cada chave vale para uma TV e só para as ações escolhidas, aparece inteira UMA vez (a API guarda só o hash), pode vencer
 * e se revoga a qualquer hora. Criar pede a passkey (o interceptador do app abre a confirmação e repete o pedido).
 */
@Component({
  selector: 'app-siri-page',
  imports: [SettingsGlyph, LoadingSkeleton, SiriSteps],
  templateUrl: './siri.page.html',
  styleUrl: './siri.page.css',
})
export class SiriPage {
  private readonly api = inject(SiriApi);
  private readonly tvApi = inject(SystemApi);
  private readonly session = inject(SessionState);
  private readonly doc = inject(DOCUMENT);

  protected readonly maxName = MAX_NAME;
  protected readonly maxKeys = SIRI_MAX_KEYS;
  protected readonly expiries = expiryOptions();

  protected readonly keys = signal<readonly SiriKey[] | null>(null);
  protected readonly tvs = signal<readonly TvItem[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly note = signal<Note | null>(null);
  protected readonly busy = signal(false);

  protected readonly creating = signal(false);
  protected readonly name = signal('');
  protected readonly tvId = signal<string | null>(null);
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly expiryDays = signal<number | null>(null);
  protected readonly appActions = signal<readonly SiriAction[]>([]);

  /** A chave recém-criada: o texto claro só existe aqui, e some quando a pessoa conclui ou sai da tela. */
  protected readonly created = signal<CreatedSiriKey | null>(null);
  protected readonly tokenNote = signal<Note | null>(null);

  protected readonly confirmingId = signal<string | null>(null);
  protected readonly openId = signal<string | null>(null);

  protected readonly dateFormat = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  protected readonly dayFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' });

  protected readonly tvName = computed(
    () => this.tvs()?.find((tv) => tv.id === this.tvId())?.name ?? '',
  );

  protected readonly groups = computed<readonly ActionGroup[]>(() => {
    const fixed = fixedActions();
    const of = (group: SiriGroup) => fixed.filter((action) => action.group === group);
    const result: ActionGroup[] = [
      {
        group: 'power',
        title: $localize`:@@settings.siri.group.power:Energia`,
        actions: of('power'),
      },
      { group: 'sound', title: $localize`:@@settings.siri.group.sound:Som`, actions: of('sound') },
      { group: 'keys', title: $localize`:@@settings.siri.group.keys:Teclas`, actions: of('keys') },
    ];
    const apps = this.appActions();
    if (apps.length > 0) {
      result.push({
        group: 'apps',
        title: $localize`:@@settings.siri.group.apps:Apps`,
        actions: apps,
      });
    }
    return result;
  });

  protected readonly canCreate = computed(
    () =>
      !this.busy() &&
      this.name().trim().length > 0 &&
      this.tvId() !== null &&
      this.chosen().size > 0,
  );

  protected readonly atLimit = computed(() => (this.keys()?.length ?? 0) >= SIRI_MAX_KEYS);

  /** Nomes dos apps por TV, para a lista de chaves mostrar "Abrir Vídeo" e não um id. */
  private readonly namesByTv = new Map<string, ReadonlyMap<string, string>>();

  constructor() {
    effect(() => {
      if (this.session.status() === 'authenticated' && untracked(() => this.keys()) === null) {
        untracked(() => void this.load());
      }
    });
  }

  protected async load(): Promise<void> {
    try {
      const [keys, tvs] = await Promise.all([this.api.keys(), this.tvApi.tvs()]);
      this.keys.set(keys);
      this.tvs.set(tvs);
      if (this.tvId() === null && tvs.length > 0)
        this.tvId.set((tvs.find((tv) => tv.isDefault) ?? tvs[0]).id);
      this.loadFailed.set(false);
    } catch {
      this.loadFailed.set(true);
    }
  }

  // ---- criar ----

  protected async openCreate(): Promise<void> {
    this.creating.set(true);
    this.name.set($localize`:@@settings.siri.default-name:Meu iPhone`);
    this.chosen.set(new Set());
    this.expiryDays.set(null);
    this.say(null);
    await this.loadApps();
  }

  protected closeCreate(): void {
    this.creating.set(false);
  }

  protected async pickTv(id: string): Promise<void> {
    if (this.tvId() === id) return;
    this.tvId.set(id);
    // As ações de app são da TV; as outras continuam valendo em qualquer uma.
    this.chosen.update((set) => new Set([...set].filter((code) => !code.startsWith('app:'))));
    await this.loadApps();
  }

  protected has(code: string): boolean {
    return this.chosen().has(code);
  }

  protected toggle(code: string, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.chosen.update((set) => {
      const next = new Set(set);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const tvId = this.tvId();
    if (!this.canCreate() || tvId === null) return;
    this.busy.set(true);
    this.say(null);
    try {
      const created = await this.api.create(
        this.name().trim(),
        tvId,
        [...this.chosen()],
        this.expiryDays(),
      );
      this.created.set(created);
      this.tokenNote.set(null);
      this.creating.set(false);
      await this.refreshKeys();
    } catch (error) {
      this.say({ text: this.createError(error), error: true });
    } finally {
      this.busy.set(false);
    }
  }

  protected async copyToken(): Promise<void> {
    const created = this.created();
    if (!created) return;
    try {
      const clipboard = this.doc.defaultView?.navigator?.clipboard;
      if (!clipboard) throw new Error('sem área de transferência');
      await clipboard.writeText(created.token);
      this.tokenNote.set({
        text: $localize`:@@settings.siri.token-copied:Chave copiada.`,
        error: false,
      });
    } catch {
      this.tokenNote.set({
        text: $localize`:@@settings.siri.token-copy-failed:Não deu para copiar sozinho: toque na chave, selecione e copie.`,
        error: true,
      });
    }
  }

  /** Concluir some com o texto claro da chave: a partir daqui só a API (que guarda o hash) a conhece. */
  protected finish(): void {
    this.created.set(null);
    this.tokenNote.set(null);
  }

  // ---- lista ----

  protected toggleOpen(key: SiriKey): void {
    this.openId.update((id) => (id === key.id ? null : key.id));
    if (this.openId() === key.id) void this.loadNames(key.tvId);
  }

  protected ask(key: SiriKey): void {
    this.confirmingId.set(key.id);
    this.say(null);
  }

  protected async revoke(key: SiriKey): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.revoke(key.id);
      this.confirmingId.set(null);
      if (this.created()?.id === key.id) this.finish();
      await this.refreshKeys();
      this.say({ text: $localize`:@@settings.siri.revoked:Chave revogada.`, error: false });
    } catch {
      this.say({
        text: $localize`:@@settings.siri.revoke-failed:Não foi possível revogar agora.`,
        error: true,
      });
    } finally {
      this.busy.set(false);
    }
  }

  protected summary(key: SiriKey): string {
    const names = this.namesByTv.get(key.tvId) ?? new Map<string, string>();
    const count = key.actions.length;
    const first = key.actions
      .map((code) => actionOfCode(code, names)?.label)
      .filter((label): label is string => !!label)
      .slice(0, 2)
      .join(', ');
    return count > 2
      ? $localize`:@@settings.siri.summary-more:${key.tvName}:tv: · ${first}:first: e mais ${count - 2}:more:`
      : $localize`:@@settings.siri.summary:${key.tvName}:tv: · ${first}:first:`;
  }

  protected used(key: SiriKey): string {
    return key.lastUsedAt
      ? $localize`:@@settings.siri.last-used:Última vez: ${this.dateFormat.format(new Date(key.lastUsedAt))}:date:`
      : $localize`:@@settings.siri.never-used:Ainda não usada`;
  }

  protected expires(key: SiriKey): string | null {
    return key.expiresAt
      ? $localize`:@@settings.siri.expires:Vale até ${this.dayFormat.format(new Date(key.expiresAt))}:date:`
      : null;
  }

  protected revokeLabel(key: SiriKey): string {
    return $localize`:@@settings.siri.revoke-label:Revogar ${key.name}:name:`;
  }

  protected revokeQuestion(key: SiriKey): string {
    return $localize`:@@settings.siri.revoke-question:Revogar ${key.name}:name:? Os atalhos que usam esta chave param de funcionar.`;
  }

  protected howLabel(key: SiriKey): string {
    return $localize`:@@settings.siri.how-label:Como montar ${key.name}:name:`;
  }

  protected namesOf(tvId: string): ReadonlyMap<string, string> {
    return this.namesByTv.get(tvId) ?? new Map();
  }

  // ---- apoio ----

  private async refreshKeys(): Promise<void> {
    try {
      this.keys.set(await this.api.keys());
    } catch {
      // A lista antiga continua na tela; a próxima abertura recarrega.
    }
  }

  private async loadApps(): Promise<void> {
    const tvId = this.tvId();
    if (tvId === null) return;
    const names = await this.loadNames(tvId);
    this.appActions.set(
      [...names]
        .map(([id, label]) => appAction(id, label))
        .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    );
  }

  private async loadNames(tvId: string): Promise<ReadonlyMap<string, string>> {
    const known = this.namesByTv.get(tvId);
    if (known) return known;
    try {
      const apps = await this.api.apps(tvId);
      const names = new Map(apps.map((app) => [app.id, app.name] as const));
      this.namesByTv.set(tvId, names);
      return names;
    } catch {
      // Sem a lista de apps a pessoa ainda cria a chave com as demais ações.
      return new Map();
    }
  }

  private say(note: Note | null): void {
    this.note.set(note);
  }

  private createError(error: unknown): string {
    const problem = problemOf(error);
    if (problem?.status === 409) {
      return $localize`:@@settings.siri.too-many:Já existem ${SIRI_MAX_KEYS}:max: chaves. Revogue uma antes de criar outra.`;
    }
    if (problem?.status === 403) {
      return $localize`:@@settings.siri.unconfirmed:A criação não foi confirmada com a passkey.`;
    }
    if (problem?.isNetwork) {
      return $localize`:@@settings.siri.network:Sem conexão com o servidor. Tente de novo.`;
    }
    return $localize`:@@settings.siri.create-failed:Não foi possível criar a chave.`;
  }
}
