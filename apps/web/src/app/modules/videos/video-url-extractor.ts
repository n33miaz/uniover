import type { RawSharePayload } from './video-inbox.model';
import { clampShareParam } from './share-input-limits';

// Links sem protocolo aparecem principalmente quando o texto é copiado do aplicativo de origem.
const LINK =
  /(?:https?:\/\/|\bwww\.|\b(?:[\w-]+\.)*(?:instagram\.com|instagr\.am|youtu\.be|youtube\.com|tiktok\.com|x\.com|twitter\.com|t\.co)\/)[^\s<>"'{}|\\^`]+/gi;

// Esquemas que embrulham outra URL sem torná-la um link http/https comum.
const EMBEDDING_SCHEME =
  /(?:^|[^a-z0-9+.-])(?:blob|data|file|filesystem|javascript|vbscript|view-source):$/i;

export function extractVideoUrl(payload: RawSharePayload | null | undefined): string | null {
  const url = typeof payload?.url === 'string' ? clampShareParam(payload.url) : null;
  if (url?.includes('@')) {
    try {
      // O parser ignora TAB, CR e LF na URL. Em texto e título, eles separam trechos da descrição.
      const parsed = new URL(url);
      if (parsed.username || parsed.password) return null;
    } catch {
      // O campo também pode conter texto com um link, tratado pela busca abaixo.
    }
  }

  let firstUrl: string | null = null;
  for (const field of [payload?.url, payload?.text, payload?.title]) {
    if (typeof field !== 'string') continue;
    const clamped = clampShareParam(field)!;
    for (const match of clamped.matchAll(LINK)) {
      // `blob:https://...`, `view-source:https://...` etc. não são links de vídeo navegáveis.
      let candidate = match[0];
      let extraClosing =
        (candidate.match(/\)/g)?.length ?? 0) - (candidate.match(/\(/g)?.length ?? 0);
      let previous: string;
      do {
        previous = candidate;
        if (/[.,!?;:"'\]}>]/.test(candidate.charAt(candidate.length - 1))) {
          candidate = candidate.slice(0, -1);
        } else if (extraClosing > 0 && candidate.endsWith(')')) {
          candidate = candidate.slice(0, -1);
          extraClosing--;
        }
      } while (candidate !== previous);
      try {
        const parsed = new URL(
          /^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate,
        );
        // O texto e o título também são armazenados, inclusive quando outro campo contém o link.
        if (parsed.username || parsed.password) return null;
        if (!firstUrl && !EMBEDDING_SCHEME.test(clamped.slice(0, match.index))) {
          firstUrl = parsed.href;
        }
      } catch {
        // Um primeiro candidato malformado não invalida o restante do compartilhamento.
      }
    }
  }
  return firstUrl;
}
