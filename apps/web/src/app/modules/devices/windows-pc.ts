/**
 * Se o navegador roda num computador com Windows (o único sistema para o qual o conector existe). Função pura: recebe
 * o que o navegador informa, para a tabela de agentes de usuário se testar sem navegador. O Windows Phone (extinto)
 * também diz "Windows NT" e fica de fora; tela de toque não exclui, porque há notebooks com ela.
 */
export function isWindowsPc(env: { readonly userAgent: string }): boolean {
  return /\bWindows NT\b/.test(env.userAgent) && !/\bWindows Phone\b/.test(env.userAgent);
}

/** Caminho do conector que o site serve (ver `public/conectar`). */
export const CONNECTOR_URL = '/conectar/conectar-uniover.cmd';
