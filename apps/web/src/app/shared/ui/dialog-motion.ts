/** Tempo-limite da saída: passado isso o diálogo sai mesmo que o navegador não avise o fim da transição. */
export const DIALOG_EXIT_TIMEOUT_MS = 300;

function isOutsideDialog(dialog: HTMLDialogElement, event: MouseEvent): boolean {
  if (event.target !== dialog) return false;
  const bounds = dialog.getBoundingClientRect();
  return (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  );
}

/** Só fecha se o mesmo toque começou e terminou no fundo, sem cruzar a borda da folha. */
export function onDialogBackdropClick(dialog: HTMLDialogElement, dismiss: () => void): void {
  let beganOutside = false;
  dialog.addEventListener('pointerdown', (event) => {
    beganOutside = event.isPrimary && event.button === 0 && isOutsideDialog(dialog, event);
  });
  dialog.addEventListener('pointercancel', () => {
    beganOutside = false;
  });
  dialog.addEventListener('click', (event) => {
    const shouldDismiss = beganOutside && isOutsideDialog(dialog, event);
    beganOutside = false;
    if (shouldDismiss) dismiss();
  });
}

/** Fecha o diálogo modal antes de quem o chamou tirá-lo do DOM. */
export function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
}

/** Devolve o foco somente para quem ainda pode recebê-lo depois de o diálogo sair do topo. */
export function restoreDialogFocus(opener: Element | null): void {
  if (
    opener instanceof HTMLElement &&
    opener.isConnected &&
    !opener.matches(':disabled, [hidden], [inert], [aria-hidden="true"]')
  ) {
    opener.focus();
  }
}

/**
 * Toca a saída de um `<dialog class="ui-dialog">` modal e chama `done` quando ela acaba (quem chama tira o
 * diálogo do DOM nesse momento). A saída é a classe `closing` (ver `styles.css`), posta com o diálogo ainda aberto:
 * ele segue no topo da tela, inerte, durante o esmaecer, o que funciona em qualquer navegador.
 *
 * `done` roda uma única vez e, quando não há nada animando (movimento reduzido, jsdom, folha sem transição), roda
 * na hora, antes de a função voltar. Com transição, espera o fim dela ou o tempo-limite, o que vier primeiro.
 */
export function leaveDialog(dialog: HTMLDialogElement, done: () => void): void {
  if (dialog.classList.contains('closing')) return;
  dialog.classList.add('closing');

  // getAnimations força o cálculo de estilo, e é aí que a transição da classe acima passa a existir.
  // Animação sem fim (um girador dentro da folha, por exemplo) nunca "termina": não vale esperar por ela.
  const running = (dialog.getAnimations?.({ subtree: true }) ?? []).filter(
    (animation) => animation.effect?.getComputedTiming().iterations !== Infinity,
  );
  if (running.length === 0) {
    done();
    return;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done();
  };
  const timer = setTimeout(finish, DIALOG_EXIT_TIMEOUT_MS);
  void Promise.allSettled(running.map((animation) => animation.finished)).then(finish);
}
