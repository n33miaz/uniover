import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { canUseModule } from '../../core/auth/guest-home';
import { SessionState } from '../../core/session/session-state';
import { SettingsGlyph, SettingsGlyphName } from './settings-glyph';
import { SETTINGS_TITLES } from './settings-titles';
import { ThemeSegment } from './theme-segment';

/** Uma linha da lista de Configurações: leva a uma tela. Só o nome: a lista nunca chama a API nem repete o que a tela diz. */
interface SettingsEntry {
  readonly id: string;
  readonly link: string;
  readonly glyph: SettingsGlyphName;
  readonly title: string;
}

/**
 * Configurações: o seletor de tema e a lista das telas, cada uma com ícone, nome e a seta. Todos veem a área pessoal e
 * Sobre; o administrador vê também a administração da casa.
 *
 * Só esconde o que o servidor também recusa, e nunca chama a API: nenhuma linha daqui faz pedido, então quem não é
 * administrador não gera nenhuma chamada a rota de administrador. Com o papel ainda desconhecido (sessão a confirmar, sem
 * lembrança do papel) a lista mostra só o que vale para todos: as linhas do administrador aparecem quando o papel chega.
 */
@Component({
  selector: 'app-settings-page',
  imports: [NgTemplateOutlet, RouterLink, RouterLinkActive, SettingsGlyph, ThemeSegment],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
})
export class SettingsPage {
  private readonly session = inject(SessionState);

  protected readonly isAdmin = computed(() => this.session.role() === 'owner');

  private readonly profileEntry: SettingsEntry = {
    id: 'profile',
    link: '/ajustes/perfil',
    glyph: 'user',
    title: SETTINGS_TITLES.profile,
  };

  private readonly appearanceEntry: SettingsEntry = {
    id: 'appearance',
    link: '/ajustes/aparencia',
    glyph: 'contrast',
    title: SETTINGS_TITLES.appearance,
  };

  /**
   * A área pessoal: Perfil, Aparência e Segurança para todos (o convidado vê lá só as próprias sessões) e o conector do
   * PC para o convidado que tem a TV. Com o papel desconhecido a Segurança espera: não se sabe o que mostrar nela.
   */
  protected readonly personal = computed<readonly SettingsEntry[]>(() => {
    const entries = [this.profileEntry, this.appearanceEntry];
    const role = this.session.role();
    if (role !== null) {
      entries.push({
        id: 'security',
        link: '/ajustes/seguranca',
        glyph: 'shield',
        title: SETTINGS_TITLES.security,
      });
    }
    // O convidado com a TV chega ao download do conector por aqui; aprovar o PC segue sendo do administrador.
    const permissions = this.session.knownPermissions();
    if (role === 'guest' && permissions !== null && canUseModule('guest', permissions, 'tv')) {
      entries.push({
        id: 'devices',
        link: '/ajustes/dispositivos',
        glyph: 'laptop',
        title: $localize`:@@settings.devices.link:Dispositivos`,
      });
    }
    return entries;
  });

  protected readonly administration = computed<readonly SettingsEntry[]>(() =>
    this.isAdmin()
      ? [
          {
            id: 'people',
            link: '/ajustes/pessoas',
            glyph: 'users',
            title: SETTINGS_TITLES.people,
          },
          {
            id: 'devices',
            link: '/ajustes/dispositivos',
            glyph: 'laptop',
            title: $localize`:@@settings.devices.link:Dispositivos`,
          },
          {
            id: 'system',
            link: '/ajustes/sistema',
            glyph: 'gear',
            title: SETTINGS_TITLES.system,
          },
          {
            id: 'audit',
            link: '/ajustes/auditoria',
            glyph: 'audit',
            title: SETTINGS_TITLES.audit,
          },
        ]
      : [],
  );

  protected readonly about: SettingsEntry = {
    id: 'about',
    link: '/ajustes/sobre',
    glyph: 'info',
    title: SETTINGS_TITLES.about,
  };
}
