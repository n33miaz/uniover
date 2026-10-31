import { HttpErrorResponse } from '@angular/common/http';
import { problemOf } from '../../../../core/auth/api-problem';
import { describeFailure } from '../../data/tv-errors';

/** `type` (último trecho) do 409 com que a API recusa uma TV cujo agente não declara o TV Livre. */
export const UNSUPPORTED_PROBLEM = 'tv-livre-unsupported';

/** Os códigos estáveis de falha que o agente devolve (`error.code`); os `adb_*` são tratados à parte, pelo prefixo. */
export const LIVRE_AGENT_CODES: readonly string[] = [
  'unsupported',
  'not_installed',
  'invalid_config',
  'photo_missing',
  'invalid_photo',
  'no_files_dir',
  'push_failed',
  'no_factory_launcher',
  'signature_mismatch',
  'install_failed',
  'apk_unavailable',
  'apk_hash_mismatch',
  'apk_invalid',
  'set_home_failed',
  'verify_failed',
  'disable_failed',
  'enable_failed',
  'uninstall_failed',
  'protected_package',
  'invalid_package',
  'sleep_failed',
  'unknown_action',
  'livre_failed',
];

/** O que cada código do agente quer dizer, em uma frase curta; `null` para um código que a tela não conhece. */
export function livreCodeMessage(code: string): string | null {
  switch (code) {
    case 'unsupported':
      return $localize`:@@tv-livre.error.unsupported:Esta TV não é compatível com o TV Livre.`;
    case 'not_installed':
      return $localize`:@@tv-livre.error.not-installed:O TV Livre não está instalado na TV.`;
    case 'invalid_config':
      return $localize`:@@tv-livre.error.invalid-config:A TV recusou esta configuração.`;
    case 'photo_missing':
      return $localize`:@@tv-livre.error.photo-missing:A foto não chegou à TV. Escolha de novo.`;
    case 'invalid_photo':
      return $localize`:@@tv-livre.error.invalid-photo:A TV não aceitou esta foto.`;
    case 'no_files_dir':
      return $localize`:@@tv-livre.error.no-files-dir:A TV não tem a pasta do TV Livre. Instale de novo.`;
    case 'push_failed':
      return $localize`:@@tv-livre.error.push-failed:Não deu para enviar os arquivos à TV.`;
    case 'no_factory_launcher':
      return $localize`:@@tv-livre.error.no-factory-launcher:Não achei o launcher de fábrica da TV.`;
    case 'signature_mismatch':
      return $localize`:@@tv-livre.error.signature-mismatch:A versão instalada tem outra assinatura. Volte ao original e instale de novo.`;
    case 'install_failed':
      return $localize`:@@tv-livre.error.install-failed:A instalação não deu certo.`;
    case 'apk_unavailable':
      return $localize`:@@tv-livre.error.apk-unavailable:O agente não tem o arquivo de instalação.`;
    case 'apk_hash_mismatch':
      return $localize`:@@tv-livre.error.apk-hash-mismatch:O arquivo de instalação não confere.`;
    case 'apk_invalid':
      return $localize`:@@tv-livre.error.apk-invalid:O arquivo de instalação é inválido.`;
    case 'set_home_failed':
      return $localize`:@@tv-livre.error.set-home-failed:Não deu para definir como padrão.`;
    case 'verify_failed':
      return $localize`:@@tv-livre.error.verify-failed:Não deu para confirmar a mudança na TV.`;
    case 'disable_failed':
      return $localize`:@@tv-livre.error.disable-failed:Não deu para desativar o launcher de fábrica.`;
    case 'enable_failed':
      return $localize`:@@tv-livre.error.enable-failed:Não deu para reativar o launcher de fábrica.`;
    case 'uninstall_failed':
      return $localize`:@@tv-livre.error.uninstall-failed:Não deu para desinstalar o TV Livre.`;
    case 'protected_package':
      return $localize`:@@tv-livre.error.protected-package:Este app é protegido e não pode ser alterado.`;
    case 'invalid_package':
      return $localize`:@@tv-livre.error.invalid-package:O nome deste app não é válido.`;
    case 'sleep_failed':
      return $localize`:@@tv-livre.error.sleep-failed:A TV não entrou no Modo Dormir.`;
    case 'unknown_action':
      return $localize`:@@tv-livre.error.unknown-action:O agente não conhece este pedido. Atualize o agente.`;
    case 'livre_failed':
      return $localize`:@@tv-livre.error.livre-failed:O TV Livre não respondeu como esperado.`;
    case 'adb_unauthorized':
      return $localize`:@@tv-livre.error.adb-unauthorized:Aceite o aviso do ADB na tela da TV e tente de novo.`;
    case 'adb_unreachable':
    case 'adb_unavailable':
    case 'adb_timeout':
      return $localize`:@@tv-livre.error.adb-unreachable:A TV não respondeu pelo ADB. Ligue a TV e tente de novo.`;
    default:
      return code.startsWith('adb_')
        ? $localize`:@@tv-livre.error.adb-failed:O ADB da TV falhou. Tente de novo.`
        : null;
  }
}

/** O código do agente que veio no problema: a extensão `agentError` (a mesma do resto da TV) ou, na falta, o `code`. */
export function livreCodeOf(error: unknown): string | null {
  if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object') {
    const body = error.error as { agentError?: unknown; code?: unknown };
    for (const candidate of [body.agentError, body.code]) {
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  }
  return problemOf(error)?.code ?? null;
}

export interface LivreFailure {
  /** Frase curta, em pt-BR, pronta para a tela. */
  readonly message: string;
  /** O código do agente, quando houve um (a tela não o mostra; serve aos testes e ao registro). */
  readonly code: string | null;
}

/**
 * Traduz a falha de uma chamada do TV Livre. Vale primeiro o que é só do TV Livre (TV sem a capacidade, código do agente,
 * foto grande demais); o resto (sem rede, sessão, permissão, agente desligado, limite de comandos) é o texto da TV.
 */
export function describeLivreFailure(error: unknown): LivreFailure {
  const problem = problemOf(error);
  const code = livreCodeOf(error);
  if (problem?.status === 409 && problem.kind === UNSUPPORTED_PROBLEM) {
    return { message: livreCodeMessage('unsupported')!, code: 'unsupported' };
  }
  const known = code ? livreCodeMessage(code) : null;
  if (known) return { message: known, code };

  switch (problem?.status) {
    case 400:
      return {
        message: $localize`:@@tv-livre.error.rejected:O pedido não foi aceito. Atualize a tela e tente de novo.`,
        code,
      };
    case 404:
      return {
        message: $localize`:@@tv-livre.error.not-found:Não achei isso no servidor. Atualize a tela.`,
        code,
      };
    case 409:
      return {
        message: $localize`:@@tv-livre.error.busy:A TV está ocupada com outro pedido. Tente de novo.`,
        code,
      };
    case 413:
      return {
        message: $localize`:@@tv-livre.error.photo-too-big:A foto é grande demais para a TV.`,
        code,
      };
    case 415:
      return {
        message: $localize`:@@tv-livre.error.photo-not-jpeg:Esta foto não está em JPEG.`,
        code,
      };
    case 504:
      // Instalar e voltar ao original levam dezenas de segundos: o tempo esgotar não quer dizer que nada aconteceu.
      return {
        message: $localize`:@@tv-livre.error.slow:A TV demorou a responder e pode ter terminado. Toque em Atualizar para conferir.`,
        code,
      };
    default:
      return { message: describeFailure(error).message, code };
  }
}
