import { ActivatedRouteSnapshot } from '@angular/router';
import { TabItem } from '../../shared/ui/tab-bar/tab-bar';

/** Para onde a seta do cabeçalho leva quando não é o Início: o endereço e o nome acessível da seta. */
export interface ShellBack {
  readonly link: string;
  readonly label: string;
}

/**
 * O que o shell lê da árvore de rotas: título do módulo (mostra o cabeçalho), abas (mostram a barra), o destino da seta
 * (`back`, quando não é o Início) e se a tela é de Ajustes (`settings`: lá o convidado não ganha o botão de
 * configurações, e o foco vai para o título ao navegar).
 */
export interface ShellRouteData {
  readonly title?: string;
  readonly tabs?: readonly TabItem[];
  /** Identidade visual opcional da casca; não altera rotas nem conteúdo. */
  readonly shellStyle?: 'training';
  readonly back?: ShellBack;
  readonly settings?: boolean;
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
