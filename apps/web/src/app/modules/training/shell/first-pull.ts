import { type Signal, effect, signal, untracked } from '@angular/core';
import type { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { RESOURCE_NAMES } from '../data/sync/resource-names';
import type { TrainingSync } from '../data/sync/training-sync';

/**
 * De quais recursos cada tela precisa para decidir um vazio. Sem isto a tela espera a passada inteira, inclusive o que não
 * lê (o catálogo de exercícios é a maior resposta do servidor e as rotinas nem o usam). Lista só o que a tela lê do banco
 * local para escolher entre mostrar dados e dizer que não há: Progresso lê o catálogo (os nomes dos exercícios e os
 * registros dependem dele), então o espera também.
 */
export const FIRST_PULL_NEEDS = {
  /** A lista de fichas e a próxima da sequência (lê as sessões para saber qual foi a última). */
  routines: [RESOURCE_NAMES.routines, RESOURCE_NAMES.program, RESOURCE_NAMES.sessions],
  /** Treinos, séries, metas e os nomes do catálogo. */
  progress: [
    RESOURCE_NAMES.sessions,
    RESOURCE_NAMES.sets,
    RESOURCE_NAMES.goals,
    RESOURCE_NAMES.exercises,
  ],
  /** Medidas, perfil e a meta de calorias do resumo. */
  body: [RESOURCE_NAMES.bodyEntries, RESOURCE_NAMES.bodyProfile, RESOURCE_NAMES.goals],
} as const satisfies Record<string, readonly string[]>;

/**
 * O aparelho ainda espera a primeira passada do servidor? Com rede, sem falha e sem nunca ter puxado, o que "não existe"
 * no banco local pode só não ter chegado ainda (a tela foi aberta direto pelo endereço, na primeira vez): quem mostra
 * "não encontrado" espera a passada acabar em vez de acusar na hora. Sem rede, ou depois de o servidor ter respondido (ou
 * falhado), a resposta do banco local vale. A espera também acaba quando a primeira passada concluiu que não vai puxar
 * agora (envio pendente que não sobe, sessão de outra conta) ou o prazo `FIRST_PULL_WAIT_MS` acabou (requisição pendurada):
 * o esqueleto não pode durar para sempre em nenhuma tela que dependa disto.
 *
 * `needs` (opcional) lista os recursos dos quais a tela depende (`FIRST_PULL_NEEDS`): com eles já puxados a espera acaba sem
 * esperar o resto da passada. É só um atalho: todas as outras saídas acima continuam valendo. Sem `needs`, espera a passada
 * inteira. Quem passa `needs` deve também chamar `TrainingSync.prioritize` com a mesma lista, para a passada começar por eles.
 *
 * Leia isto dentro de um `effect` ou `computed`: os sinais lidos aqui fazem a tela reavaliar quando a passada termina.
 */
export function awaitingFirstPull(
  sync: TrainingSync,
  connectivity: ConnectivityService,
  needs?: readonly string[],
): boolean {
  return (
    connectivity.online() &&
    sync.error() === null &&
    sync.lastPullAt() === null &&
    !sync.firstPassSettled() &&
    !sync.firstPullWaitExpired() &&
    !(needs !== undefined && sync.resourcesPulled(needs))
  );
}

/**
 * Passa a valer `true` quando o que a tela lê do banco local já inclui o que a espera trouxe. Sem isto, a espera por
 * `needs` acaba logo depois de a última linha ser gravada, e a leitura que a tela faz por causa dessa gravação ainda pode
 * estar a caminho: por um instante a tela mostraria um vazio falso. Se a tela chegou a esperar, ao fim da espera ela lê de
 * novo (`reload`) e só então vale `true`; se nunca esperou (aparelho que já tinha puxado, sem rede), vale `true` de
 * imediato, sem leitura extra. Chame num contexto de injeção (construtor da tela).
 */
export function settledAfterFirstPull(
  sync: TrainingSync,
  connectivity: ConnectivityService,
  needs: readonly string[],
  reload: () => Promise<void>,
): Signal<boolean> {
  const settled = signal(false);
  let waited = false;
  effect(() => {
    const waiting = awaitingFirstPull(sync, connectivity, needs);
    untracked(() => {
      if (waiting) {
        waited = true;
      } else if (waited) {
        waited = false;
        // Uma leitura que falha não pode deixar o esqueleto para sempre: a tela segue com o que o banco local tem.
        const done = () => settled.set(true);
        void reload().then(done, done);
      } else {
        settled.set(true);
      }
    });
  });
  return settled.asReadonly();
}
