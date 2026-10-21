import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AppearanceService, ThemePreference } from '../../core/session/appearance.service';
import { SessionState } from '../../core/session/session-state';
import { SettingsGlyph, SettingsGlyphName } from './settings-glyph';
import { SETTINGS_TITLES, roleLabel } from './settings-titles';

/** Uma linha da lista de Ajustes: leva a uma tela. O resumo é fixo (ou vem do que já está na memória): a lista nunca chama a API. */
interface SettingsEntry {
  readonly id: string;
  readonly link: string;
  readonly glyph: SettingsGlyphName;
  readonly title: string;
  readonly summary: string;
}

/** Recurso planejado que ainda não existe: um cartão calmo, sem link. */
interface SoonEntry {
  readonly id: string;
  readonly glyph: SettingsGlyphName;
  readonly title: string;
  readonly summary: string;
}

function themeSummary(preference: ThemePreference): string {
  switch (preference) {
    case 'light':
      return $localize`:@@settings.list.appearance-light:Tema claro`;
    case 'dark':
      return $localize`:@@settings.list.appearance-dark:Tema escuro`;
    default:
      return $localize`:@@settings.list.appearance-auto:Tema automático`;
  }
}

/**
 * Ajustes: a lista das telas, cada uma com ícone, nome, um resumo curto e a seta. Todos veem Perfil, Aparência e
 * Sobre; o administrador vê também Segurança, Pessoas, Aparelhos e Sistema (e o recurso que ainda vem: Auditoria, em um
 * cartão calmo, sem link).
 *
 * Só esconde o que o servidor também recusa, e nunca chama a API: nenhuma linha daqui faz pedido, então quem não é
 * administrador não gera nenhuma chamada a rota de administrador. Com o papel ainda desconhecido (sessão a confirmar, sem
 * lembrança do papel) a lista mostra só o que vale para todos: as linhas do administrador aparecem quando o papel chega.
 */
@Component({
  selector: 'app-settings-page',
  imports: [NgTemplateOutlet, RouterLink, RouterLinkActive, SettingsGlyph],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
})
export class SettingsPage {
  private readonly session = inject(SessionState);
  private readonly appearance = inject(AppearanceService);

  protected readonly isAdmin = computed(() => this.session.role() === 'owner');

  private readonly profileEntry = computed<SettingsEntry>(() => {
    const user = this.session.user();
    const role = roleLabel(this.session.role());
    return {
      id: 'profile',
      link: '/ajustes/perfil',
      glyph: 'user',
      title: SETTINGS_TITLES.profile,
      summary:
        user && role
          ? `${user.displayName} · ${role}`
          : $localize`:@@settings.list.profile-summary:Nome, e-mail e conta`,
    };
  });

  private readonly appearanceEntry = computed<SettingsEntry>(() => ({
    id: 'appearance',
    link: '/ajustes/aparencia',
    glyph: 'contrast',
    title: SETTINGS_TITLES.appearance,
    summary: themeSummary(this.appearance.preference()),
  }));

  /** Perfil e Aparência para todos; Segurança só para o administrador. */
  protected readonly account = computed<readonly SettingsEntry[]>(() => {
    const entries = [this.profileEntry(), this.appearanceEntry()];
    if (this.isAdmin()) {
      entries.push({
        id: 'security',
        link: '/ajustes/seguranca',
        glyph: 'shield',
        title: SETTINGS_TITLES.security,
        summary: $localize`:@@settings.list.security-summary:Passkeys que confirmam ações perigosas`,
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
            summary: $localize`:@@settings.list.people-summary:Convites e convidados`,
          },
          {
            id: 'devices',
            link: '/ajustes/aparelhos',
            glyph: 'laptop',
            title: $localize`:@@settings.devices.link:Aparelhos`,
            summary: $localize`:@@settings.devices.hint:Parear o agente do PC de casa`,
          },
          {
            id: 'system',
            link: '/ajustes/sistema',
            glyph: 'gear',
            title: SETTINGS_TITLES.system,
            summary: $localize`:@@settings.list.system-summary:Qual computador controla a TV`,
          },
        ]
      : [],
  );

  /** O que o administrador ainda vai ganhar: aparece, mas não leva a lugar nenhum. */
  protected readonly soon = computed<readonly SoonEntry[]>(() =>
    this.isAdmin()
      ? [
          {
            id: 'audit',
            glyph: 'audit',
            title: $localize`:@@settings.soon.audit:Auditoria`,
            summary: $localize`:@@settings.soon.audit-summary:Quem fez o quê, e quando`,
          },
        ]
      : [],
  );

  protected readonly about: SettingsEntry = {
    id: 'about',
    link: '/ajustes/sobre',
    glyph: 'info',
    title: SETTINGS_TITLES.about,
    summary: $localize`:@@settings.list.about-summary:Versão do app e da API`,
  };
}
