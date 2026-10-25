/**
 * "Chrome no Windows": o que o celular mostra do computador que pediu a entrada, tirado do User-Agent (texto do próprio
 * computador, então só se confia nele para rotular, nunca para decidir nada). Sem rótulo reconhecível devolve `null`.
 */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const browser = browserOf(userAgent);
  const system = systemOf(userAgent);
  if (browser && system)
    return $localize`:@@auth.qr.device:${browser}:browser: no ${system}:system:`;
  return browser ?? system;
}

function browserOf(ua: string): string | null {
  // A ordem importa: Edge, Opera e o Chrome do iOS também dizem "Chrome" ou "Safari".
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

function systemOf(ua: string): string | null {
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return null;
}
