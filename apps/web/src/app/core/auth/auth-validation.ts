/** Teto do e-mail na API (RFC 5321). */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Mesma forma mínima que a API confere (uma arroba, nada vazio, sem espaço): serve para avisar de um engano
 * antes de ir ao servidor, não para provar que o e-mail existe. A API continua sendo quem decide.
 */
export function isPlausibleEmail(value: string): boolean {
  const email = value.trim();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1;
}
