/**
 * Detecção do aparelho e do navegador para a dica de "adicionar à tela de início". Funções puras: recebem o que o
 * navegador informa (`userAgent`, `maxTouchPoints`, `navigator.standalone`, `matchMedia`) e devolvem uma resposta;
 * quem lê o `window` de verdade é `readInstallEnv`. Assim a tabela de agentes de usuário se testa sem navegador.
 *
 * O que é fato e o que é convenção (nada aqui foi conferido num iPhone real):
 * - iOS e iPadOS 16.4 ou mais novos instalam pelo menu Compartilhar do Safari e também do Chrome, do Edge, do
 *   Firefox e do Orion; o iOS não dispara `beforeinstallprompt`. Fontes: MDN, "Making PWAs installable"
 *   (developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) e WebKit,
 *   "WebKit Features in Safari 16.4" (webkit.org/blog/13966).
 * - `navigator.standalone` é um booleano só de leitura do iOS que diz se a página abriu a partir da tela de início.
 *   Fonte: Apple, "Configuring Web Applications" (developer.apple.com/library/archive/documentation/
 *   AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications). A media query
 *   `(display-mode: standalone)` é o equivalente do padrão (MDN, mesma página acima).
 * - Fichas dos navegadores de terceiros no iPhone: `CriOS/` (Chromium, docs/ios/user_agent.md), `FxiOS/` (MDN,
 *   "Firefox user agent string") e `EdgiOS/` (Microsoft Learn, "Detecting Microsoft Edge from your website").
 * - Navegador embutido em outro app (Instagram, Facebook...): o `WKWebView` com o agente padrão não manda o
 *   token `Safari/`, e é por essa falta que a maioria é reconhecida. Os tokens de cada app abaixo vêm do projeto
 *   de código aberto `inapp-spy` (MIT, github.com/shalanah/inapp-spy), não de documentação dos fabricantes, e
 *   também não foram conferidos num aparelho. Ficaram de fora os que não tinham certeza: TikTok, Threads e o
 *   WhatsApp (o visualizador do WhatsApp usa o Safari embutido e o agente é idêntico ao do Safari: não há como
 *   detectar, por isso a folha de instrução cobre o caso com um texto).
 * - iPadOS 13 em diante se apresenta como Mac ("sites para computador"); o que o separa de um Mac de verdade é
 *   a tela de toque (`maxTouchPoints > 1`). É convenção amplamente usada, sem documento da Apple que a descreva.
 */

/** O que o navegador informa; todos os campos podem faltar (teste, servidor, navegador antigo). */
export interface InstallEnvInput {
  readonly userAgent: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
  /** `navigator.standalone`: só o iOS o tem. */
  readonly standalone?: boolean;
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
}

export type IosBrowser = 'safari' | 'chrome-ios' | 'firefox-ios' | 'edge-ios' | 'in-app' | 'other';

/** Apps com navegador embutido que mandam o token `Safari/` (o do Google, por exemplo) ou que valem conferir à parte. */
const IN_APP_TOKENS =
  /\b(FBAN|FBAV|FB_IAB)\b|\bInstagram\b|\bLine\/|\bTwitter\b|\bSnapchat\b|\bLinkedInApp\b|\bGSA\/|\bMicroMessenger\b|\bReddit\//i;

export function isIos(env: InstallEnvInput): boolean {
  if (/\b(iPhone|iPod|iPad)\b/.test(env.userAgent)) return true;
  // iPadOS com "site para computador": o agente diz Mac, mas só o iPad tem tela de toque.
  const claimsMac = /\bMacintosh\b/.test(env.userAgent) || env.platform === 'MacIntel';
  return claimsMac && (env.maxTouchPoints ?? 0) > 1;
}

export function isAndroid(env: InstallEnvInput): boolean {
  return /\bAndroid\b/i.test(env.userAgent);
}

/** Celular ou tablet: onde faz sentido oferecer o atalho sem o dono ter pedido. */
export function isMobileDevice(env: InstallEnvInput): boolean {
  return isIos(env) || isAndroid(env);
}

/** O app já abriu a partir da tela de início (ou como app instalado): não há o que oferecer. */
export function isStandalone(env: InstallEnvInput): boolean {
  if (env.standalone === true) return true;
  try {
    return env.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Qual navegador roda no iPhone/iPad. Só tem sentido quando `isIos` é verdadeiro; fora do iOS devolve `other`.
 * A ordem importa: os apps conhecidos primeiro (alguns mandam `Safari/` e ainda assim são embutidos), depois os
 * navegadores de terceiros, depois a falta do `Safari/` (o embutido genérico) e só então o Safari.
 */
export function iosBrowser(env: InstallEnvInput): IosBrowser {
  if (!isIos(env)) return 'other';
  const ua = env.userAgent;
  if (IN_APP_TOKENS.test(ua)) return 'in-app';
  if (/\bCriOS\//.test(ua)) return 'chrome-ios';
  if (/\bFxiOS\//.test(ua)) return 'firefox-ios';
  if (/\bEdgiOS\//.test(ua)) return 'edge-ios';
  if (!/\bSafari\//.test(ua)) return 'in-app';
  return /\bVersion\/\d/.test(ua) ? 'safari' : 'other';
}

/** Lê o ambiente real. Sem `window` (servidor, teste sem DOM) devolve um ambiente vazio: nada a oferecer. */
export function readInstallEnv(win: Window | null | undefined): InstallEnvInput {
  if (!win) return { userAgent: '' };
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent ?? '',
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    standalone: nav.standalone,
    matchMedia: typeof win.matchMedia === 'function' ? (query) => win.matchMedia(query) : undefined,
  };
}
