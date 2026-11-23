import type { RawSharePayload } from './video-inbox.model';

// Links sem protocolo aparecem principalmente quando o texto é copiado do aplicativo de origem.
const LINK =
  /(?:https?:\/\/|\bwww\.|\b(?:[\w-]+\.)*(?:instagram\.com|instagr\.am|youtu\.be|youtube\.com|tiktok\.com|x\.com|twitter\.com|t\.co)\/)[^\s<>"'{}|\\^`]+/gi;

export function extractVideoUrl(payload: RawSharePayload | null | undefined): string | null {
  for (const field of [payload?.url, payload?.text, payload?.title]) {
    if (typeof field !== 'string') continue;
    for (const match of field.matchAll(LINK)) {
      const candidate = match[0]
        .replace(/[.,!?;:"'\]}>]+$/, '')
        .replace(/\)+$/, (end, offset, input: string) => {
          const open = (input.slice(0, offset).match(/\(/g) ?? []).length;
          const closed = (input.slice(0, offset).match(/\)/g) ?? []).length;
          return end.slice(0, Math.max(0, open - closed));
        });
      try {
        return new URL(/^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate).href;
      } catch {
        // Um primeiro candidato malformado não invalida o restante do compartilhamento.
      }
    }
  }
  return null;
}
