import { registerUnsavedWork } from '../../../core/pwa/unsaved-work';
import type { LocalSession } from '../data/sessions/session';

/**
 * Um treino ainda não encerrado e aberto numa tela segura a recarga automática de atualização: a sessão fica gravada no
 * aparelho e a recarga a retoma, mas a casca não se troca no meio de uma série ou de um descanso. O toque no aviso não pergunta
 * nada por causa dele (nada a salvar). Chame num inicializador de campo ou no construtor da tela; a fonte sai sozinha quando a
 * tela é destruída.
 */
export function registerOpenSessionWork(session: () => LocalSession | undefined): void {
  registerUnsavedWork(() => {
    const current = session();
    return current !== undefined && current.finishedAt === null;
  }, 'session');
}
