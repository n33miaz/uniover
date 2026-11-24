import type { RawSharePayload } from './video-inbox.model';
import { clampShareParam } from './share-input-limits';

// Links sem protocolo aparecem principalmente quando o texto é copiado do aplicativo de origem.
const LINK =
  /(?:https?:\/\/|\bwww\.|\b(?:[\w-]+\.)*(?:instagram\.com|instagr\.am|youtu\.be|youtube\.com|tiktok\.com|x\.com|twitter\.com|t\.co)\/)[^\s<>"'{}|\\^`]+/gi;

export function extractVideoUrl(payload: RawSharePayload | null | undefined): string | null {
  for (const field of [payload?.url, payload?.text, payload?.title]) {
    if (typeof field !== 'string') continue;
    const clamped = clampShareParam(field)!;
    for (const match of clamped.matchAll(LINK)) {
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
        return new URL(/^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate).href;
      } catch {
        // Um primeiro candidato malformado não invalida o restante do compartilhamento.
      }
    }
  }
  return null;
}
