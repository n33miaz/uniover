import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { SCOPED_MODULE_SLUGS, ScopedModuleSlug } from '../modules/module-slugs';

// Nomes de produto, não texto de tela: não passam pelo i18n. Têm de ser os `name` dos manifests em
// `public/<módulo>/manifest.webmanifest` (o e2e confere), porque é o que o iOS grava ao "Adicionar à Tela de Início".
const ROOT_PRODUCT_NAME = 'UniOver';
const MODULE_PRODUCT_NAMES: Record<ScopedModuleSlug, string> = {
  tv: 'UniOver TV',
  treino: 'UniOver Treino',
};

const APPLE_TITLE_META = 'apple-mobile-web-app-title';

/**
 * Escopo de um caminho, pela mesma regra do servidor (`PwaIndexRenderer`): vale o primeiro segmento, sem diferenciar
 * maiúsculas, e só se for igual a um módulo da lista (`/tvx` não é da TV). Qualquer outro caminho é da raiz (`null`).
 * Consulta e fragmento (`/convite#segredo`) ficam de fora.
 */
export function moduleScopeOf(path: string): ScopedModuleSlug | null {
  const segment = path.split(/[?#]/, 1)[0].split('/')[1] ?? '';
  let decoded = segment;
  try {
    // O servidor lê o caminho já decodificado (`/%74v` chega como `/tv`).
    decoded = decodeURIComponent(segment);
  } catch {
    // Percentual malformado: não é módulo nenhum.
  }
  const lowered = decoded.toLowerCase();
  return SCOPED_MODULE_SLUGS.find((slug) => slug === lowered) ?? null;
}

/**
 * Mantém o `<head>` coerente com a tela aberta: manifest, ícone da tela de início e nome do app.
 *
 * O servidor só escolhe isso ao entregar o HTML. Quem entra por `/convite` ou `/entrar` recebe o manifest da raiz e,
 * depois, o roteador leva para `/tv` sem recarregar a página: o documento seguiria com o ícone e o nome do UniOver, e
 * o "Adicionar à Tela de Início" feito ali gravaria o app errado. Por isso o escopo é recalculado a cada navegação.
 *
 * A troca do `<link rel="manifest">` serve ao iOS, que lê o link, o ícone e o título no momento do "Adicionar à Tela de
 * Início". No Chromium ela NÃO basta: a instalabilidade e o `beforeinstallprompt` valem para o manifest da carga da página,
 * então a instalação nativa de outro módulo exige carga completa (`InstallHintService` cuida disso, com um marcador no
 * endereço). Por isso o link continua sendo trocado: no iOS é o que faz o atalho sair com o nome e o ícone certos.
 */
@Injectable({ providedIn: 'root' })
export class ModuleHeadService {
  private readonly doc = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly destroyRef = inject(DestroyRef);
  private started = false;

  /** Chamado na inicialização do app. Acerta o head pelo endereço aberto e o reacerta a cada navegação. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // O servidor já trocou os links, mas o `<title>` do index.html é fixo: sem isto uma carga direta em /tv/ mostraria
    // "UniOver" até a primeira navegação terminar.
    const path = this.doc.defaultView?.location.pathname;
    if (path !== undefined) this.apply(path);
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      // O endereço depois dos redirecionamentos: um convidado em `/` acaba em `/tv`, e `/tvx` cai na raiz.
      .subscribe((event) => this.apply(event.urlAfterRedirects));
  }

  /** Idempotente: só toca no que mudou e nunca cria um segundo elemento. Nunca lança (o head é um reforço). */
  private apply(path: string): void {
    try {
      const slug = moduleScopeOf(path);
      const prefix = slug ? `/${slug}` : '';
      const name = slug ? MODULE_PRODUCT_NAMES[slug] : ROOT_PRODUCT_NAME;
      this.setLink('manifest', `${prefix}/manifest.webmanifest`);
      this.setLink('apple-touch-icon', `${prefix}/apple-touch-icon.png`);
      if (this.doc.title !== name) this.title.setTitle(name);
      if (this.meta.getTag(`name="${APPLE_TITLE_META}"`)?.content !== name) {
        this.meta.updateTag({ name: APPLE_TITLE_META, content: name });
      }
    } catch {
      // Sem documento utilizável (teste, ambiente sem DOM): não há head para acertar.
    }
  }

  private setLink(rel: string, href: string): void {
    const head = this.doc.head;
    let links = Array.from(head.querySelectorAll(`link[rel="${rel}"]`));
    if (links.length === 0) {
      // Sem o servidor para trocar o marcador (ng serve) o link não existe: cria um só.
      const created = this.doc.createElement('link');
      created.setAttribute('rel', rel);
      head.appendChild(created);
      links = [created];
    }
    for (const link of links) {
      // `getAttribute`, nunca `link.href`: a propriedade é absoluta e nunca bateria; reescrever o mesmo valor faria o
      // Chromium buscar o manifest de novo.
      if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    }
  }
}
