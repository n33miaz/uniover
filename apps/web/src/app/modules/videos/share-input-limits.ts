import type { RawSharePayload } from './video-inbox.model';

/**
 * Limite máximo de caracteres para cada campo recebido pelo Web Share Target.
 *
 * Impede DoS local por strings excessivamente longas: regex catastrófica,
 * travamento de UI ou QuotaExceededError no sessionStorage.
 */
export const MAX_SHARE_PARAM_LENGTH = 4096;

/** Trunca o valor ao limite de compartilhamento, quando presente. */
export function clampShareParam(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length > MAX_SHARE_PARAM_LENGTH ? value.slice(0, MAX_SHARE_PARAM_LENGTH) : value;
}

export function clampSharePayload({
  url,
  text,
  title,
  timestamp,
}: RawSharePayload): RawSharePayload {
  return {
    url: clampShareParam(url),
    text: clampShareParam(text),
    title: clampShareParam(title),
    timestamp,
  };
}
