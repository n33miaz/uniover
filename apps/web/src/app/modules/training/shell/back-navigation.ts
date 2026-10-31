import { Location } from '@angular/common';
import { Injectable, type Signal, computed, inject } from '@angular/core';
import { canUseModule } from '../../../core/auth/guest-home';
import { isStandalone } from '../../../core/pwa/install-env';
import { INSTALL_ENV } from '../../../core/pwa/install-hint.service';
import { SessionState } from '../../../core/session/session-state';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';

/**
 * Pai lógico de cada rota do módulo, pelo `path` declarado em `training.routes.ts` (`:id` é o parâmetro da rota).
 * `null` marca as telas de nível de aba (Início, Exercícios, Rotinas, Progresso, Corpo): a seta única da casca leva ao
 * Início do site. Nas demais, essa mesma seta leva ao pai daqui.
 */
export const TRAINING_ROUTE_PARENTS: Readonly<Record<string, string | null>> = {
  '': null,
  sessao: '/treino',
  'sessao/exercicio': '/treino/sessao',
  glossario: '/treino',
  exercicios: null,
  'exercicios/novo': '/treino/exercicios',
  'exercicios/mapa': '/treino/exercicios',
  'exercicios/:id/editar': '/treino/exercicios/:id',
  'exercicios/:id': '/treino/exercicios',
  rotinas: null,
  'rotinas/nova': '/treino/rotinas',
  'rotinas/:id': '/treino/rotinas',
  progresso: null,
  alimentacao: '/treino/corpo',
  corpo: null,
  'corpo/avaliacoes/importar': '/treino/corpo/avaliacoes',
  'corpo/avaliacoes/nova': '/treino/corpo/avaliacoes',
  'corpo/avaliacoes/:id/editar': '/treino/corpo/avaliacoes',
  'corpo/avaliacoes/:id': '/treino/corpo/avaliacoes',
  'corpo/avaliacoes': '/treino/corpo',
};

/**
 * Telas com mais de uma origem legítima: o pai lógico continua sendo o da tabela acima, mas voltar uma entrada também é
 * certo quando ela é uma destas. O glossário abre por Hoje e pelas Rotinas, e quem o abriu pelas Rotinas volta a elas.
 * A chave é o caminho da própria tela.
 */
const EXTRA_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  'treino/glossario': ['/treino/rotinas'],
};

/** Pais dos fluxos que ainda precisam de um destino escrito no código depois de uma ação que muda a própria tela. */
export const TRAINING_LOGICAL_PARENTS = {
  workoutDay: TRAINING_ROUTE_PARENTS['sessao'] as string,
  workoutExercise: TRAINING_ROUTE_PARENTS['sessao/exercicio'] as string,
  foodDiary: TRAINING_ROUTE_PARENTS['alimentacao'] as string,
  assessments: TRAINING_ROUTE_PARENTS['corpo/avaliacoes'] as string,
  assessment: TRAINING_ROUTE_PARENTS['corpo/avaliacoes/:id'] as string,
} as const;

/** O pai da rota concreta, com os parâmetros que também aparecem no destino. */
export function trainingParent(url: string): string | null {
  const path = url.split(/[?#]/)[0].replace(/^\/treino\/?/, '');
  const segments = path.split('/').filter(Boolean);
  for (const [route, parent] of Object.entries(TRAINING_ROUTE_PARENTS).sort(
    ([left], [right]) => right.length - left.length,
  )) {
    const parts = route.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params = new Map<string, string>();
    if (
      !parts.every((part, index) => {
        if (!part.startsWith(':')) return part === segments[index];
        params.set(part.slice(1), segments[index]);
        return true;
      })
    )
      continue;
    return parent === null
      ? null
      : parent.replace(/:([a-zA-Z]+)/g, (_, key: string) => params.get(key) ?? '');
  }
  return null;
}

/** Uma entrada do histórico do navegador como o roteador a conhece: o endereço e a entrada anterior a ela. */
interface HistoryEntry {
  readonly url: string;
  readonly previous: HistoryEntry | null;
}

/**
 * "Voltar" das telas de segundo nível (ficha, formulário, editor, sessão). Sempre termina no pai lógico, e escolhe o
 * caminho que não perde nada:
 * - se a entrada anterior do histórico já é o pai (mesmo caminho; os parâmetros de busca do pai, se houver, têm de bater),
 *   volta uma entrada, e o navegador devolve a lista como estava, com filtros e posição de rolagem;
 * - senão (link direto, recarga, vindo de outro módulo, entrada que não é o pai) navega ao pai trocando a entrada atual,
 *   para o voltar do navegador não formar laço com a tela que acabou de sair.
 *
 * O roteador só guarda no histórico o número da navegação, não o endereço da entrada anterior; por isso o serviço
 * acompanha as navegações e monta a cadeia de entradas. Entradas de antes de ele existir ou de uma sessão anterior da
 * página (recarga) ficam desconhecidas, e desconhecido é tratado como "não é o pai".
 */
@Injectable({ providedIn: 'root' })
export class BackNavigation {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  /** Entradas conhecidas pelo número da navegação que as criou, para achar a atual quando o navegador volta ou avança. */
  private readonly byId = new Map<number, HistoryEntry>();
  private current: HistoryEntry | null = null;
  private starting: { trigger: string; restoredId: number | undefined } | null = null;

  constructor() {
    // Criado depois da primeira navegação (a casca do módulo só aparece quando o banco da conta abre): a tela em que o
    // serviço nasceu já é uma entrada, e é dela que a próxima navegação parte.
    if (this.router.navigated) {
      this.current = { url: this.router.url, previous: null };
      const id = (this.location.getState() as { navigationId?: number } | null)?.navigationId;
      if (id !== undefined) this.byId.set(id, this.current);
    }
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.starting = {
          trigger: event.navigationTrigger ?? 'imperative',
          restoredId: event.restoredState?.navigationId,
        };
      } else if (event instanceof NavigationEnd) {
        this.record(event.id, event.urlAfterRedirects);
      }
    });
  }

  back(parent: string): void {
    const previous = this.current?.previous ?? null;
    const origins = [parent, ...(EXTRA_ORIGINS[this.pathOf(this.current?.url ?? '')] ?? [])];
    if (previous !== null && origins.some((origin) => this.isParent(previous.url, origin)))
      this.location.back();
    else void this.router.navigateByUrl(parent, { replaceUrl: true });
  }

  private record(id: number, url: string): void {
    const starting = this.starting;
    this.starting = null;
    if (starting?.trigger === 'popstate') {
      // O navegador moveu o histórico: a entrada atual é a que ele restaurou, desde que seja mesmo a que conhecemos
      // (depois de uma recarga os números recomeçam e podem coincidir com os de entradas antigas). Só o caminho conta: a
      // lista reescreve os próprios filtros no endereço sem passar pelo roteador, e a entrada continua a mesma.
      const known =
        starting.restoredId === undefined ? undefined : this.byId.get(starting.restoredId);
      this.current =
        known !== undefined && this.pathOf(known.url) === this.pathOf(url)
          ? known
          : { url, previous: null };
      return;
    }
    const extras = this.router.currentNavigation()?.extras;
    if (extras?.skipLocationChange) return;
    // Navegar ao próprio endereço, como `replaceUrl`, troca a entrada em vez de empilhar outra.
    const replaces = extras?.replaceUrl === true || this.current?.url === url;
    const entry: HistoryEntry = {
      url,
      previous: replaces ? (this.current?.previous ?? null) : this.current,
    };
    this.byId.set(id, entry);
    this.current = entry;
  }

  /** Mesmo caminho do pai, e com os parâmetros de busca que o pai pede (o resto, como o filtro de uma lista, não conta). */
  private isParent(candidate: string, parent: string): boolean {
    if (this.pathOf(candidate) !== this.pathOf(parent)) return false;
    const queryOf = this.router.parseUrl(candidate).queryParams;
    return Object.entries(this.router.parseUrl(parent).queryParams).every(
      ([key, value]) => queryOf[key] === value,
    );
  }

  private pathOf(url: string): string {
    const segments = this.router.parseUrl(url).root.children['primary']?.segments ?? [];
    return segments.map((segment) => segment.path).join('/');
  }
}

/**
 * O rótulo da seta do topo do Treino (`null` = sem seta), igual na casca e no esqueleto que a antecede, para o voltar já
 * estar lá enquanto o banco abre. A seta existe em toda tela, com uma exceção: quem só tem o Treino e o abriu pelo app
 * instalado não tem para onde ir a partir de uma aba (a Início fica fora do escopo `/treino/`, e o iOS o tiraria do app);
 * para ele a raiz das abas fica sem seta. As telas internas voltam ao pai de sempre. Chamar num contexto de injeção.
 */
export function injectTrainingBackLabel(
  url: () => string,
  hasHandler: () => boolean,
): Signal<string | null> {
  const session = inject(SessionState);
  const installed = isStandalone(inject(INSTALL_ENV));
  const text = $localize`:@@training.shell.back:Voltar`;
  return computed<string | null>(() => {
    if (!hasHandler() && trainingParent(url()) === null) {
      const onlyTraining =
        session.isGuest() && !canUseModule(session.role(), session.knownPermissions(), 'tv');
      if (installed && onlyTraining) return null;
    }
    return text;
  });
}
