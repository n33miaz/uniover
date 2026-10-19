import { ActivatedRouteSnapshot } from '@angular/router';
import { TabItem } from '../../shared/ui/tab-bar/tab-bar';

/** O que o shell lê da árvore de rotas: título do módulo (mostra o cabeçalho) e abas (mostra a barra). */
export interface ShellRouteData {
  readonly title?: string;
  readonly tabs?: readonly TabItem[];
}

/** Junta o `data` da raiz até a folha; o mais específico vence. Não depende da herança de dados do roteador. */
export function collectShellData(root: ActivatedRouteSnapshot): ShellRouteData {
  let merged: ShellRouteData = {};
  let route: ActivatedRouteSnapshot | null = root;
  while (route) {
    merged = { ...merged, ...(route.data as ShellRouteData) };
    route = route.firstChild;
  }
  return merged;
}
