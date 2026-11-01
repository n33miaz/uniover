import { canUseModule } from '../../core/auth/guest-home';
import { ModuleDefinition } from '../../core/modules/module-registry';
import type { AccountRole } from '../../core/session/session-state';
import type { PersonHome } from './people-api';

/**
 * Os módulos que a pessoa vê na Início, na ordem em que aparecem, para o dono ler em Pessoas. Só entram os que já têm
 * tela (os "em breve" estão sempre lá e não dizem nada sobre a escolha dela).
 *
 * Parte do que a conta guardou: os módulos ligados, na ordem escolhida, e, no fim, os que o catálogo ganhou depois da
 * escolha (o app os liga por padrão, e a lista guardada nunca os cita). Depois tira o que a conta não alcança: o convidado
 * só vê o que as permissões dele liberam. Assim o texto bate com o que a Início dela realmente mostra.
 */
export function homeModuleTitles(
  home: PersonHome,
  catalog: readonly ModuleDefinition[],
  role: AccountRole | null,
  permissions: readonly string[] | null,
): string[] {
  const known = new Map(catalog.map((module) => [module.id, module]));
  const mentioned = new Set(home.entries.map((entry) => entry.id));
  const ids = [
    ...home.entries.filter((entry) => entry.enabled).map((entry) => entry.id),
    ...catalog.map((module) => module.id).filter((id) => !mentioned.has(id)),
  ];
  return ids
    .flatMap((id) => {
      const module = known.get(id);
      return module ? [module] : [];
    })
    .filter((module) => module.status === 'available' && canUseModule(role, permissions, module.id))
    .map((module) => module.title);
}
