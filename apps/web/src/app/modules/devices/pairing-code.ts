/** Alfabeto do código de pareamento: sem vogais (não forma palavra) e sem 0 e 1 (confundem com O e I). */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const CODE_LENGTH = 8;

/** Forma digitada na tela: maiúsculas, só letras e números, no máximo 8, com hífen depois do quarto. */
export function formatCodeInput(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/**
 * Forma enviada à API: aceita com ou sem hífen, com espaços e em minúsculas. Devolve `null` quando o texto não é
 * um código válido (tamanho ou caractere fora do alfabeto), igual à regra da API.
 */
export function normalizeCode(input: string): string | null {
  const clean = input.replace(/[-\s]/g, '').toUpperCase();
  if (clean.length !== CODE_LENGTH) return null;
  return [...clean].every((char) => ALPHABET.includes(char)) ? clean : null;
}

/** Limite de caracteres do nome do aparelho na API. */
export const MAX_DEVICE_NAME = 60;

/**
 * Limite do apelido da TV, o que cabe no cabeçalho do controle (o mesmo teto do apelido que cada pessoa pode dar à TV nas
 * preferências). A API aceita até `MAX_DEVICE_NAME`; a tela de cadastro pede curto.
 */
export const MAX_TV_NICKNAME = 20;

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u;

/** Nome em branco é válido (o aparelho fica com o nome que ele mesmo informou); senão segue a regra da API. */
export function isValidDeviceName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length === 0 || (trimmed.length <= MAX_DEVICE_NAME && NAME_PATTERN.test(trimmed));
}

/** O apelido da TV: em branco vale (a TV se chama "TV"); senão a mesma regra de nome, só que curto. */
export function isValidTvNickname(name: string): boolean {
  const trimmed = name.trim();
  return isValidDeviceName(trimmed) && trimmed.length <= MAX_TV_NICKNAME;
}
