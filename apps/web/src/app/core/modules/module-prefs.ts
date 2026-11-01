import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  linkedSignal,
  untracked,
} from '@angular/core';
import { SessionState } from '../session/session-state';
import { ModuleDefinition, ModuleRegistry, WidgetSize } from './module-registry';
import { AccountPreferences, HomeEntry, PreferencesApi } from './preferences-api';

export interface WidgetPref {
  readonly id: string;
  readonly size: WidgetSize;
  readonly enabled: boolean;
}

/**
 * A chave de antes de haver contas: guardava a escolha de quem usou o aparelho por último, sem dizer de quem era. Hoje só
 * serve de prefixo da chave de cada conta (`modulePrefsStorageKey`) e de nome do que se descarta.
 */
export const MODULE_PREFS_KEY = 'uniover.home.widgets.v1';

/** Onde ficam, por conta, os módulos ligados, a ordem e o tamanho dos blocos da Início neste aparelho. */
export function modulePrefsStorageKey(accountId: string): string {
  return `${MODULE_PREFS_KEY}.${encodeURIComponent(accountId)}`;
}

/**
 * Onde fica, por conta, o que o aparelho sabe da sincronização com a conta: a versão que leu da API e se há mudança
 * local ainda sem enviar. Só controle do aparelho; nunca guarda a escolha em si (essa fica na chave acima).
 */
export const MODULE_PREFS_SYNC_KEY = 'uniover.home.sync.v1';

export function modulePrefsSyncKey(accountId: string): string {
  return `${MODULE_PREFS_SYNC_KEY}.${encodeURIComponent(accountId)}`;
}

/** O que o aparelho lembra da conta: a versão lida e se a escolha local espera para subir. */
interface SyncMeta {
  readonly version: number;
  readonly dirty: boolean;
}

/** Mesma forma que a API aceita para o id de um módulo; o que não cabe nela nunca é enviado. */
const SYNCABLE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Troca o item de lugar com o vizinho (`-1` sobe, `1` desce); devolve a mesma lista se não houver para onde ir. */
export function moveWidget(list: readonly WidgetPref[], id: string, delta: -1 | 1): WidgetPref[] {
  const from = list.findIndex((item) => item.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Leva o item para a posição `to` (usado pelo arrastar). */
export function moveWidgetTo(list: readonly WidgetPref[], id: string, to: number): WidgetPref[] {
  const from = list.findIndex((item) => item.id === id);
  if (from < 0 || to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Preferências da Início: módulos ligados/desligados, ordem e tamanho dos blocos. O aparelho guarda uma cópia por conta
 * (`localStorage`), que vale sozinha sem rede, e a conta guarda a escolha na API, para valer em todo aparelho dela e para o
 * dono saber o que cada pessoa deixou na Início.
 *
 * Sincronização, sempre em segundo plano e sem nunca bloquear a tela:
 * - ao entrar (sessão confirmada), lê a escolha da conta. Se a conta já tem uma, ela vale e substitui a cópia local; se
 *   não tem e este aparelho já tinha uma, essa sobe UMA vez (a migração do que existia antes da sincronização);
 * - ao salvar o Personalizar, a cópia local muda na hora e a escolha é enviada sobre a versão lida. Sem rede, fica marcada
 *   como pendente e sobe na próxima entrada, ao voltar a conexão;
 * - se outro aparelho gravou antes (versão diferente), a da conta vale: ninguém apaga uma mudança mais nova sem tê-la visto.
 *
 * A escolha é relida quando a conta da sessão muda (sair e entrar noutra conta sem recarregar a página), e uma conta sem
 * escolha usa o padrão. Sem conta conhecida vale o padrão e nada é gravado nem enviado. A chave de antes, sem conta, não
 * dizia de quem era a escolha: é descartada, nunca entregue a quem entrar primeiro. Nunca guarda dado sensível.
 */
@Injectable({ providedIn: 'root' })
export class ModulePrefs {
  private readonly registry = inject(ModuleRegistry);
  private readonly session = inject(SessionState);
  private readonly api = inject(PreferencesApi);
  private readonly doc = inject(DOCUMENT);
  private readonly storage = this.openStorage();
  /** Uma operação de sincronização por vez: ler, migrar e enviar nunca se sobrepõem. */
  private queue: Promise<void> = Promise.resolve();
  private readonly stored = linkedSignal<string | null, readonly WidgetPref[]>({
    source: () => this.session.accountId(),
    computation: (accountId) => this.read(accountId),
  });

  /** Todos os módulos, na ordem escolhida; módulos novos do catálogo entram no fim com o padrão. */
  readonly widgets = computed<readonly WidgetPref[]>(() => {
    const known = new Map(this.registry.modules.map((m) => [m.id, m]));
    const kept = this.stored().filter((pref) => known.has(pref.id));
    const seen = new Set(kept.map((pref) => pref.id));
    const added = this.registry.modules
      .filter((module) => !seen.has(module.id))
      .map((module) => this.defaults(module));
    return [...kept, ...added];
  });

  /** Só o que aparece na grade: módulo desligado some. */
  readonly visible = computed(() =>
    this.widgets()
      .filter((pref) => pref.enabled)
      .flatMap((pref) => {
        const definition = this.registry.find(pref.id);
        return definition ? [{ definition, size: pref.size }] : [];
      }),
  );

  constructor() {
    // Sincroniza quando a sessão de uma conta conhecida se confirma (e de novo se a conta ou a sessão mudam): a Início não
    // precisa estar aberta, quem monta isto é a casca do app.
    effect(() => {
      const accountId = this.session.accountId();
      this.session.sessionAccountId();
      if (!accountId || !this.session.isAuthenticated()) return;
      untracked(() => this.enqueue(() => this.sync(accountId)));
    });
    const onOnline = () => {
      const accountId = this.session.accountId();
      if (accountId && this.session.isAuthenticated()) this.enqueue(() => this.sync(accountId));
    };
    const win = this.doc.defaultView;
    win?.addEventListener('online', onOnline);
    inject(DestroyRef).onDestroy(() => win?.removeEventListener('online', onOnline));
  }

  apply(next: readonly WidgetPref[]): void {
    this.stored.set(next.map(({ id, size, enabled }) => ({ id, size, enabled })));
    this.write();
    const accountId = this.session.accountId();
    if (!accountId) return;
    // A mudança fica marcada como pendente já, para sobreviver a um envio que não termina (sem rede, aba fechada).
    this.writeMeta(accountId, { version: this.readMeta(accountId)?.version ?? 0, dirty: true });
    this.enqueue(() => this.push(accountId));
  }

  setEnabled(id: string, enabled: boolean): void {
    this.apply(this.widgets().map((pref) => (pref.id === id ? { ...pref, enabled } : pref)));
  }

  private defaults(module: ModuleDefinition): WidgetPref {
    return { id: module.id, size: module.defaultSize, enabled: true };
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(accountId: string | null): readonly WidgetPref[] {
    if (!accountId) return [];
    try {
      // A escolha de antes das contas não diz de quem foi: dá-la a quem entra agora vazaria a de outra pessoa.
      this.storage?.removeItem(MODULE_PREFS_KEY);
    } catch {
      // armazenamento bloqueado: não há o que apagar nem o que vazar
    }
    try {
      const raw = this.storage?.getItem(modulePrefsStorageKey(accountId));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item: unknown) => {
        const pref = item as Partial<WidgetPref> | null;
        const valid =
          typeof pref?.id === 'string' &&
          (pref.size === 'small' || pref.size === 'wide') &&
          typeof pref.enabled === 'boolean';
        // A Início não oferece escolha de tamanho e desenha todos os cartões iguais: um `wide` salvo é só o do Treino de
        // quando ele era largo por padrão, e volta a `small` (vira `small` também no disco, na próxima gravação).
        return valid
          ? [{ id: pref.id as string, size: 'small' as const, enabled: pref.enabled! }]
          : [];
      });
    } catch {
      return []; // JSON corrompido: volta ao padrão em vez de quebrar a Início
    }
  }

  /** Enfileira sem nunca rejeitar: sincronizar é melhoria e uma falha dela nunca pode derrubar a tela nem a suíte. */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => undefined);
  }

  /**
   * Dá para falar com a API em nome desta conta: a sessão está confirmada, a conta ainda é esta e o token em memória é dela
   * (nunca ler ou gravar com o token de outra conta). Sem isso a escolha só vale no aparelho, e sobe quando a sessão voltar.
   */
  private isCurrent(accountId: string): boolean {
    return (
      this.session.isAuthenticated() &&
      this.session.accountId() === accountId &&
      this.session.isSessionOf(accountId)
    );
  }

  private async sync(accountId: string): Promise<void> {
    if (!this.isCurrent(accountId)) return;
    let remote: AccountPreferences;
    try {
      remote = await this.api.get();
    } catch {
      return; // sem rede ou servidor dormindo: a cópia local segue valendo e a próxima entrada tenta de novo
    }
    if (!this.isCurrent(accountId)) return;

    const meta = this.readMeta(accountId);
    const hasLocal = this.read(accountId).length > 0;
    if (meta?.dirty) {
      // Mudança local que não subiu: sobe se a conta ainda está na versão em que ela se baseou; senão a da conta é mais nova.
      if (remote.version === meta.version) await this.push(accountId);
      else this.adopt(accountId, remote);
      return;
    }
    if (remote.home !== null) {
      this.adopt(accountId, remote);
      return;
    }
    if (meta === null && hasLocal) {
      // A conta ainda não tem nada e este aparelho tinha: é a migração, uma vez só (depois disso há metadado).
      this.writeMeta(accountId, { version: remote.version, dirty: true });
      await this.push(accountId);
      return;
    }
    this.writeMeta(accountId, { version: remote.version, dirty: false });
  }

  /** Envia a escolha local sobre a versão lida; a recusa por versão e a falha de rede têm tratamentos diferentes. */
  private async push(accountId: string): Promise<void> {
    const meta = this.readMeta(accountId);
    if (!meta?.dirty || !this.isCurrent(accountId)) return;
    const home: HomeEntry[] = this.stored()
      .filter((pref) => SYNCABLE_ID.test(pref.id))
      .map(({ id, enabled }) => ({ id, enabled }));
    try {
      const outcome = await this.api.save(meta.version, home);
      if (!this.isCurrent(accountId)) return;
      if (outcome.saved)
        this.writeMeta(accountId, { version: outcome.current.version, dirty: false });
      else this.adopt(accountId, outcome.current);
    } catch {
      // Sem rede ou recusa que não é de versão: continua pendente e sobe na próxima sincronização.
    }
  }

  /** A escolha da conta passa a valer neste aparelho (e vira a cópia local). */
  private adopt(accountId: string, remote: AccountPreferences): void {
    if (!this.isCurrent(accountId)) return;
    const prefs: WidgetPref[] = (remote.home ?? []).flatMap((entry) =>
      typeof entry?.id === 'string' && typeof entry.enabled === 'boolean'
        ? [{ id: entry.id, size: 'small' as const, enabled: entry.enabled }]
        : [],
    );
    // A cópia local só é regravada se o que ela vale mudou: reler a mesma escolha da conta não mexe no que está no disco.
    const changed = JSON.stringify(this.read(accountId)) !== JSON.stringify(prefs);
    this.stored.set(prefs);
    try {
      if (remote.home === null) this.storage?.removeItem(modulePrefsStorageKey(accountId));
      else if (changed)
        this.storage?.setItem(modulePrefsStorageKey(accountId), JSON.stringify(prefs));
    } catch {
      // sem espaço ou bloqueado: vale até recarregar
    }
    this.writeMeta(accountId, { version: remote.version, dirty: false });
  }

  private readMeta(accountId: string): SyncMeta | null {
    try {
      const raw = this.storage?.getItem(modulePrefsSyncKey(accountId));
      const parsed = raw ? (JSON.parse(raw) as Partial<SyncMeta>) : null;
      return parsed && Number.isInteger(parsed.version) && typeof parsed.dirty === 'boolean'
        ? { version: parsed.version as number, dirty: parsed.dirty }
        : null;
    } catch {
      return null;
    }
  }

  private writeMeta(accountId: string, meta: SyncMeta): void {
    try {
      this.storage?.setItem(modulePrefsSyncKey(accountId), JSON.stringify(meta));
    } catch {
      // sem espaço ou bloqueado: sem o metadado, a próxima entrada trata como a primeira
    }
  }

  private write(): void {
    const accountId = this.session.accountId();
    if (!accountId) return;
    try {
      this.storage?.setItem(modulePrefsStorageKey(accountId), JSON.stringify(this.stored()));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }
}
