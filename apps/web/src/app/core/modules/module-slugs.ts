/**
 * Caminhos de módulo que têm manifest e escopo próprios. Arquivo sem dependência de Angular de propósito:
 * o service worker e o script de build também o leem, e os três precisam concordar sobre a lista.
 */
export const SCOPED_MODULE_SLUGS = ['tv', 'treino'] as const;

export type ScopedModuleSlug = (typeof SCOPED_MODULE_SLUGS)[number];
