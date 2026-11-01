import { InstallEnvInput, isAndroid, isIos, isStandalone, readInstallEnv } from './install-env';

/** Cabeçalho com que o app diz à API em que aparelho roda e se está aberto como app instalado. */
export const CLIENT_ENV_HEADER = 'X-UniOver-Client-Env';

export type ClientPlatform = 'iphone' | 'ipad' | 'android' | 'pc';
export type ClientMode = 'standalone' | 'browser';

/** O aparelho: o iPad (inclusive o que se apresenta como Mac) separado do iPhone, o Android e, no resto, o computador. */
export function clientPlatform(env: InstallEnvInput): ClientPlatform {
  if (isIos(env))
    return /\biPad\b/.test(env.userAgent) || !/\b(iPhone|iPod)\b/.test(env.userAgent)
      ? 'ipad'
      : 'iphone';
  return isAndroid(env) ? 'android' : 'pc';
}

/**
 * `iphone;standalone`, `android;browser`...: o que a API grava na sessão para o dono ver em Pessoas quem instalou o app.
 * O app instalado é o que `isStandalone` reconhece (`navigator.standalone` no iOS, `display-mode` nos outros). É só
 * informação que o aparelho declara: a API nunca decide acesso por ela e ignora qualquer valor fora da lista.
 */
export function clientEnvHeaderValue(env: InstallEnvInput): string {
  const mode: ClientMode = isStandalone(env) ? 'standalone' : 'browser';
  return `${clientPlatform(env)};${mode}`;
}

/** O valor do cabeçalho para a janela de verdade; sem janela (servidor, teste sem DOM) não há o que informar. */
export function currentClientEnvHeader(
  win: Window | null | undefined = globalThis.window,
): string | null {
  return win ? clientEnvHeaderValue(readInstallEnv(win)) : null;
}
