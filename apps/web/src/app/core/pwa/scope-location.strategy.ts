import { PathLocationStrategy } from '@angular/common';
import { Injectable } from '@angular/core';
import { SCOPED_MODULE_SLUGS } from '../modules/module-slugs';

const MODULE_ROOT = new RegExp(`^/(?:${SCOPED_MODULE_SLUGS.join('|')})(?=$|[?#])`);

/**
 * Põe a barra final na raiz de um módulo com app próprio: `/tv` vira `/tv/` (com a consulta e o fragmento intactos).
 *
 * O app instalado de cada módulo tem `scope` `/tv/` (ou `/treino/`, `/pc/`), e o navegador só considera dentro do app
 * o endereço que começa com o escopo. O roteador do Angular escreve as raízes sem a barra (`/tv`), e aí o Chrome trata a
 * tela como fora do app: mostra a barra de endereço e a notificação do navegador em cima do app instalado. Subpáginas
 * (`/tv/livre`) já estão dentro do escopo e não mudam.
 */
export function withScopeSlash(url: string): string {
  return url.replace(MODULE_ROOT, (root) => `${root}/`);
}

/**
 * O mesmo `PathLocationStrategy` do Angular, só com a barra final nas raízes dos módulos ao escrever no histórico e nos
 * `href`. A leitura não muda: o `Location` tira a barra final, então o roteador continua vendo `/tv`.
 */
@Injectable()
export class ScopePathLocationStrategy extends PathLocationStrategy {
  override prepareExternalUrl(internal: string): string {
    return withScopeSlash(super.prepareExternalUrl(internal));
  }
}
