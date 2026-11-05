import type { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import type { TrainingSync } from '../data/sync/training-sync';

/**
 * O aparelho ainda espera a primeira passada do servidor? Com rede, sem falha e sem nunca ter puxado, o que "não existe"
 * no banco local pode só não ter chegado ainda (a tela foi aberta direto pelo endereço, na primeira vez): quem mostra
 * "não encontrado" espera a passada acabar em vez de acusar na hora. Sem rede, ou depois de o servidor ter respondido (ou
 * falhado), a resposta do banco local vale. A espera também acaba quando a primeira passada concluiu que não vai puxar
 * agora (envio pendente que não sobe, sessão de outra conta) ou o prazo `FIRST_PULL_WAIT_MS` acabou (requisição pendurada):
 * o esqueleto não pode durar para sempre em nenhuma tela que dependa disto.
 *
 * Leia isto dentro de um `effect` ou `computed`: os sinais lidos aqui fazem a tela reavaliar quando a passada termina.
 */
export function awaitingFirstPull(sync: TrainingSync, connectivity: ConnectivityService): boolean {
  return (
    connectivity.online() &&
    sync.error() === null &&
    sync.lastPullAt() === null &&
    !sync.firstPassSettled() &&
    !sync.firstPullWaitExpired()
  );
}
