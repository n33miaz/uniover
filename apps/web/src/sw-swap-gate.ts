/**
 * Pergunta a uma aba se ela tem trabalho não salvo: `true` (ocupada), `false` (livre) ou `undefined` (não respondeu no prazo).
 */
export type AskTab = () => Promise<boolean | undefined>;

/**
 * A troca automática do service worker. `skipWaiting` com `clientsClaim` muda o worker de TODAS as abas abertas (e apaga o
 * precache antigo), então uma aba ociosa não pode decidir sozinha: o worker pergunta a cada aba e só troca se todas
 * responderem "livre". Quem não responde (aba congelada, sem ouvinte, erro) conta como ocupada: na dúvida, não troca.
 * Sem nenhuma aba para perguntar também não troca (não há quem tenha pedido).
 */
export async function swapIfSafe(
  tabs: readonly AskTab[],
  skip: () => Promise<void>,
): Promise<'swapped' | 'busy'> {
  if (tabs.length === 0) return 'busy';
  const answers = await Promise.all(tabs.map((ask) => ask().catch(() => undefined)));
  if (answers.some((answer) => answer !== false)) return 'busy';
  await skip();
  return 'swapped';
}
