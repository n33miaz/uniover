/** Mesmo tamanho mínimo da senha do dono (a API é quem decide; isto só poupa uma ida ao servidor). */
export const MIN_PASSWORD_LENGTH = 10;

/** Teto da API: proteção contra entrada gigante no hash, não uma regra de segurança. */
export const MAX_PASSWORD_LENGTH = 256;

/** 0 = vazia · 1 = fraca · 2 = razoável · 3 = boa · 4 = forte. */
export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export interface PasswordCheck {
  readonly length: number;
  /** A única regra que barra o envio: o tamanho mínimo. */
  readonly meetsMinimum: boolean;
  /** Quantas famílias de caractere aparecem: minúsculas, maiúsculas, números e o resto (0 a 4). */
  readonly variety: number;
  /** Só um conselho para quem digita: nunca impede o envio. */
  readonly level: StrengthLevel;
}

// Letras sem caixa (por exemplo, ideogramas) contam como minúsculas: o que importa é a variedade.
const FAMILIES = [/[\p{Ll}\p{Lo}\p{Lm}]/u, /[\p{Lu}\p{Lt}]/u, /\p{N}/u, /[^\p{L}\p{N}]/u];

/**
 * Avalia uma senha só pelo comprimento e pela variedade (sem lista de senhas comuns nem biblioteca): curta demais
 * ou quase toda repetida é fraca; a partir do mínimo, cada faixa de comprimento e cada família a mais sobe um
 * degrau. A senha nunca sai daqui: a função é pura e não guarda nada.
 */
export function checkPassword(password: string): PasswordCheck {
  const length = password.length;
  if (length === 0) return { length, meetsMinimum: false, variety: 0, level: 0 };

  const variety = FAMILIES.filter((family) => family.test(password)).length;
  const meetsMinimum = length >= MIN_PASSWORD_LENGTH;
  const distinct = new Set(password).size;
  // "aaaaaaaaaa" cumpre o tamanho, mas não protege nada.
  if (!meetsMinimum || distinct < 4) return { length, meetsMinimum, variety, level: 1 };

  let points = 0;
  if (length >= 14) points++;
  if (length >= 18) points++;
  if (variety >= 2) points++;
  if (variety >= 3) points++;
  if (distinct < 6) points = 0;

  const level: StrengthLevel = points === 0 ? 2 : points <= 2 ? 3 : 4;
  return { length, meetsMinimum, variety, level };
}
