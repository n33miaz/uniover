import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, linkedSignal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { TvSummary } from './tv-types';

/** Onde fica, por conta, a TV que a pessoa escolheu neste aparelho. */
export const TV_SELECTED_KEY = 'uniover.tv.selected';

export function tvSelectedStorageKey(accountId: string): string {
  return `${TV_SELECTED_KEY}.${encodeURIComponent(accountId)}`;
}

/**
 * A escolha guardada. `isDefault` vai junto para as preferências e o último estado acharem a chave certa antes de a lista
 * de TVs chegar (sem rede, por exemplo): a TV padrão sempre usou as chaves de antes de haver várias.
 */
interface StoredSelection {
  readonly id: string;
  readonly isDefault: boolean;
}

function parseStored(raw: unknown): StoredSelection | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  return typeof value['id'] === 'string' && value['id'] !== ''
    ? { id: value['id'], isDefault: value['isDefault'] === true }
    : null;
}

/**
 * Qual TV a tela controla. Guarda a lista das TVs que a conta vê (o `TvStore` a atualiza) e a escolha da pessoa, que fica
 * neste aparelho, em chave própria por conta. Não depende do `TvStore` nem das permissões, para o cliente HTTP, as
 * preferências e o controle de acesso poderem consultá-la sem ciclo.
 *
 * A regra central: **só se manda `tvId` à API com duas ou mais TVs visíveis.** Com uma só (ou sem lista, quando a rota
 * falhou) a API escolhe a única visível, e o app se comporta exatamente como antes de haver várias TVs. A TV escolhida que
 * deixou de existir não é um erro: vale a padrão (ou a primeira da lista, que a API já ordena com a padrão na frente).
 */
@Injectable({ providedIn: 'root' })
export class TvSelection {
  private readonly session = inject(SessionState);
  private readonly storage = this.openStorage();

  /**
   * As TVs que a conta vê. Volta a `null` quando a conta da sessão muda (A sai e B entra sem recarregar a página): a lista é
   * de quem a pediu, e com ela de A, as chamadas de B levariam o `tvId` de uma TV que ele talvez nem veja.
   */
  private readonly _tvs = linkedSignal<string | null, readonly TvSummary[] | null>({
    source: () => this.session.accountId(),
    computation: () => null,
  });
  private readonly stored = linkedSignal<string | null, StoredSelection | null>({
    source: () => this.session.accountId(),
    computation: (accountId) => this.read(accountId),
  });

  /** As TVs que a conta vê; `null` enquanto a lista não chegou (ou se a rota falhou). */
  readonly tvs = this._tvs.asReadonly();

  /** Há mais de uma TV: só então o título vira seletor e as chamadas levam `tvId`. */
  readonly multiple = computed(() => (this._tvs()?.length ?? 0) > 1);

  /** A TV em uso: a escolhida, se ainda existe; senão a padrão, ou a primeira. `null` sem lista. */
  readonly selected = computed<TvSummary | null>(() => {
    const list = this._tvs();
    if (!list || list.length === 0) return null;
    const wanted = this.stored()?.id;
    return (
      list.find((tv) => tv.id === wanted) ?? list.find((tv) => tv.isDefault) ?? list[0] ?? null
    );
  });

  /**
   * O `tvId` que vai nas chamadas e no fluxo de eventos. Antes da lista chegar vale a escolha guardada (o fluxo abre já
   * na TV certa, sem reabrir); com a lista, só quando há mais de uma TV. `null`: a API escolhe a única visível.
   */
  readonly tvId = computed<string | null>(() => {
    if (this._tvs() === null) return this.stored()?.id ?? null;
    return this.multiple() ? (this.selected()?.id ?? null) : null;
  });

  /**
   * Chave das escolhas por TV (preferências, último estado): `null` para a TV padrão, que mantém as chaves de antes de
   * haver várias (nada se perde nem se copia), e o id para as outras.
   */
  readonly scope = computed<string | null>(() => {
    const selected = this.selected();
    if (selected) return selected.isDefault ? null : selected.id;
    const stored = this.stored();
    return stored && !stored.isDefault ? stored.id : null;
  });

  /** Põe a lista das TVs visíveis (vazia = nenhuma; a escolha guardada não se apaga, a TV pode voltar). */
  setTvs(list: readonly TvSummary[] | null): void {
    this._tvs.set(list);
  }

  /** A pessoa escolheu uma TV da lista; ignora um id que não está nela. */
  select(id: string): void {
    const tv = this._tvs()?.find((item) => item.id === id);
    if (!tv) return;
    const next: StoredSelection = { id: tv.id, isDefault: tv.isDefault };
    this.stored.set(next);
    this.write(this.session.accountId(), next);
  }

  private openStorage(): Storage | null {
    try {
      return inject(DOCUMENT).defaultView?.localStorage ?? null;
    } catch {
      return null; // armazenamento bloqueado (modo privado, política do navegador)
    }
  }

  private read(accountId: string | null): StoredSelection | null {
    if (!accountId) return null;
    try {
      const raw = this.storage?.getItem(tvSelectedStorageKey(accountId));
      return parseStored(raw ? JSON.parse(raw) : null);
    } catch {
      return null; // JSON corrompido ou armazenamento bloqueado: começa sem escolha
    }
  }

  private write(accountId: string | null, value: StoredSelection): void {
    if (!accountId) return;
    try {
      this.storage?.setItem(tvSelectedStorageKey(accountId), JSON.stringify(value));
    } catch {
      // sem espaço ou bloqueado: a escolha vale só até recarregar
    }
  }
}
