/**
 * Quando o service worker novo toma as páginas abertas (`clients.claim()`) ao ativar. Tomar uma página muda o worker dela e
 * tira o precache antigo debaixo dela, então isso nunca acontece no meio de uma operação:
 * - na primeira instalação (não havia worker antes): as páginas abertas ainda não têm nenhum, e não há versão anterior a
 *   preservar;
 * - depois de o app pedir a troca (`SKIP_WAITING`): o pedido só sai de `PwaUpdateService`, que antes conferiu trabalho em
 *   curso nesta aba e nas outras;
 * - nunca nos outros casos. Um worker que espera ativa sozinho quando nenhuma página dele resta (a próxima abertura a frio) e
 *   as páginas abertas depois já nascem sob ele, sem precisar de `claim`.
 */
export interface ClaimPolicy {
  /** No evento `install`: `hasActiveWorker` diz se já havia um worker ativo (o que o novo vai substituir). */
  onInstall(hasActiveWorker: boolean): void;
  /** O app pediu a troca (`SKIP_WAITING`). */
  onSkipWaitingRequest(): void;
  /** No evento `activate`: o worker deve tomar as páginas abertas agora? */
  shouldClaim(): boolean;
}

export function createClaimPolicy(): ClaimPolicy {
  let firstInstall = false;
  let requested = false;
  return {
    onInstall: (hasActiveWorker) => {
      firstInstall = !hasActiveWorker;
    },
    onSkipWaitingRequest: () => {
      requested = true;
    },
    shouldClaim: () => firstInstall || requested,
  };
}
