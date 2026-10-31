import { actionLabel as stepUpActionLabel } from '../../core/auth/step-up/step-up-dialog';
import { AuditItem, AuditOutcome, AuditPeriod, AuditSources, isOutcome } from './audit-model';
import type { SettingsGlyphName } from './settings-glyph';
import { permissionLabels } from './settings-titles';

/*
 * Tudo que a trilha mostra em palavras de gente. A API devolve códigos estáveis (`login_failed`, `tv.key`); a tela nunca
 * os exibe: um código que a tela ainda não conhece vira um texto genérico, não o código.
 */

/** O nome de uma ação em português, ou `null` quando a tela ainda não conhece o código. */
export function knownActionLabel(code: string): string | null {
  switch (code) {
    // Conta e acesso
    case 'login_succeeded':
      return $localize`:@@settings.audit.action.login-succeeded:Entrou na conta`;
    case 'login_failed':
      return $localize`:@@settings.audit.action.login-failed:Tentou entrar`;
    case 'login_locked':
      return $localize`:@@settings.audit.action.login-locked:Entrada bloqueada`;
    case 'refresh_succeeded':
      return $localize`:@@settings.audit.action.refresh-succeeded:Sessão renovada`;
    case 'refresh_reuse_detected':
      return $localize`:@@settings.audit.action.refresh-reuse:Sessão antiga reutilizada`;
    case 'refresh_recovered':
      return $localize`:@@settings.audit.action.refresh-recovered:Sessão recuperada depois de uma resposta perdida`;
    case 'logout':
      return $localize`:@@settings.audit.action.logout:Saiu da conta`;
    case 'owner_created':
      return $localize`:@@settings.audit.action.owner-created:Conta de administrador criada`;
    case 'passkey_registered':
      return $localize`:@@settings.audit.action.passkey-registered:Passkey cadastrada`;
    case 'passkey_renamed':
      return $localize`:@@settings.audit.action.passkey-renamed:Passkey renomeada`;
    case 'passkey_removed':
      return $localize`:@@settings.audit.action.passkey-removed:Passkey removida`;
    case 'step_up_succeeded':
      return $localize`:@@settings.audit.action.step-up-succeeded:Confirmou com a passkey`;
    case 'step_up_failed':
      return $localize`:@@settings.audit.action.step-up-failed:Confirmação com a passkey falhou`;
    case 'guest_invite_created':
      return $localize`:@@settings.audit.action.invite-created:Convite criado`;
    case 'guest_invite_accepted':
      return $localize`:@@settings.audit.action.invite-accepted:Convite aceito`;
    case 'guest_invite_revoked':
      return $localize`:@@settings.audit.action.invite-revoked:Convite revogado`;
    case 'guest_paused':
      return $localize`:@@settings.audit.action.guest-paused:Acesso pausado`;
    case 'guest_resumed':
      return $localize`:@@settings.audit.action.guest-resumed:Acesso retomado`;
    case 'guest_revoked':
      return $localize`:@@settings.audit.action.guest-revoked:Acesso revogado`;
    case 'session_revoked':
      return $localize`:@@settings.audit.action.session-revoked:Sessão encerrada`;
    case 'permissions_changed':
      return $localize`:@@settings.audit.action.permissions-changed:Permissões alteradas`;
    case 'profile_updated':
      return $localize`:@@settings.audit.action.profile-updated:Perfil atualizado`;
    case 'qr_login_approved':
      return $localize`:@@settings.audit.action.qr-login-approved:Confirmou a entrada de um computador`;
    case 'qr_login_denied':
      return $localize`:@@settings.audit.action.qr-login-denied:Recusou a entrada de um computador`;
    case 'qr_login_succeeded':
      return $localize`:@@settings.audit.action.qr-login-succeeded:Computador entrou pelo QR`;
    case 'audit_exported':
      return $localize`:@@settings.audit.action.audit-exported:Auditoria exportada`;
    // Dispositivos
    case 'pairing_started':
      return $localize`:@@settings.audit.action.pairing-started:Pareamento iniciado`;
    case 'pairing_approved':
      return $localize`:@@settings.audit.action.pairing-approved:Pareamento aprovado`;
    case 'pairing_denied':
      return $localize`:@@settings.audit.action.pairing-denied:Pareamento recusado`;
    case 'pairing_expired':
      return $localize`:@@settings.audit.action.pairing-expired:Pareamento expirou`;
    case 'pairing_token_issued':
      return $localize`:@@settings.audit.action.pairing-token:Acesso do aparelho liberado`;
    case 'agent_revoked':
      return $localize`:@@settings.audit.action.agent-revoked:Aparelho revogado`;
    case 'agent_logs_viewed':
      return $localize`:@@settings.audit.action.agent-logs-viewed:Registro do aparelho visto`;
    case 'agent_update_requested':
      return $localize`:@@settings.audit.action.agent-update-requested:Atualização do aparelho pedida`;
    case 'agent_restart_requested':
      return $localize`:@@settings.audit.action.agent-restart-requested:Reinício do aparelho pedido`;
    case 'agent_offline':
      return $localize`:@@settings.audit.action.agent-offline:Computador sem sinal`;
    case 'agent_online':
      return $localize`:@@settings.audit.action.agent-online:Computador de volta`;
    case 'agent_rollback_requested':
      return $localize`:@@settings.audit.action.agent-rollback-requested:Volta do aparelho à versão anterior pedida`;
    // TV
    case 'tv.key':
      return $localize`:@@settings.audit.action.tv-key:Tecla enviada à TV`;
    case 'tv.text':
      return $localize`:@@settings.audit.action.tv-text:Texto enviado à TV`;
    case 'tv.app.launch':
      return $localize`:@@settings.audit.action.tv-app-launch:App aberto na TV`;
    case 'tv.wake':
      return $localize`:@@settings.audit.action.tv-wake:TV ligada`;
    case 'tv.power-off':
      return $localize`:@@settings.audit.action.tv-power-off:TV desligada`;
    case 'tv.cleanup':
      return $localize`:@@settings.audit.action.tv-cleanup:Limpeza da TV`;
    case 'tv.cleanup.setting':
      return $localize`:@@settings.audit.action.tv-cleanup-setting:Fechar apps em segundo plano alterado`;
    case 'tv.permission.request':
      return $localize`:@@settings.audit.action.tv-permission-request:Permissão da TV pedida`;
    case 'tv.discover':
      return $localize`:@@settings.audit.action.tv-discover:TVs da rede procuradas`;
    case 'tv.apps.refresh':
      return $localize`:@@settings.audit.action.tv-apps-refresh:Lista de apps atualizada`;
    case 'tv.shortcuts.reorder':
      return $localize`:@@settings.audit.action.tv-shortcuts-reorder:Atalhos reordenados`;
    case 'tv.shortcut.update':
      return $localize`:@@settings.audit.action.tv-shortcut-update:Atalho editado`;
    case 'tv.config.bind':
      return $localize`:@@settings.audit.action.tv-config-bind:Computador da TV trocado`;
    default:
      return null;
  }
}

/** O nome da ação para a linha da lista: sempre um texto, nunca o código. */
export function auditActionLabel(code: string): string {
  return knownActionLabel(code) ?? $localize`:@@settings.audit.action.other:Outra ação`;
}

/** De onde vem o registro (a fonte da trilha), em palavras. */
export function moduleLabel(code: string): string {
  switch (code) {
    case 'identity':
      return $localize`:@@settings.audit.module.identity:Conta e acesso`;
    case 'devices':
      return $localize`:@@settings.audit.module.devices:Dispositivos`;
    case 'tv':
      return $localize`:@@settings.audit.module.tv:TV`;
    default:
      return $localize`:@@settings.audit.module.other:Outro módulo`;
  }
}

/** O resultado de uma linha: o texto, a forma (ícone) e o tom do chip. O tom nunca é a única pista. */
export interface OutcomeView {
  readonly label: string;
  readonly glyph: SettingsGlyphName;
  readonly tone: 'ok' | 'warn' | 'bad' | 'plain';
}

export function outcomeView(code: string): OutcomeView {
  switch (code as AuditOutcome) {
    case 'success':
      return {
        label: $localize`:@@settings.audit.outcome.success:Sucesso`,
        glyph: 'check',
        tone: 'ok',
      };
    case 'denied':
      return {
        label: $localize`:@@settings.audit.outcome.denied:Recusado`,
        glyph: 'ban',
        tone: 'warn',
      };
    case 'failure':
      return {
        label: $localize`:@@settings.audit.outcome.failure:Erro`,
        glyph: 'alert',
        tone: 'bad',
      };
    default:
      return {
        label: $localize`:@@settings.audit.outcome.unknown:Sem resultado`,
        glyph: 'info',
        tone: 'plain',
      };
  }
}

/** Os resultados que a folha de filtros oferece: os que a API diz e que a tela sabe nomear, na ordem da API. */
export function outcomeChoices(sources: AuditSources | null): readonly AuditOutcome[] {
  const fromApi = sources?.outcomes.filter(isOutcome) ?? [];
  return fromApi.length > 0 ? fromApi : ['success', 'denied', 'failure'];
}

export function periodLabel(period: AuditPeriod): string {
  switch (period) {
    case '24h':
      return $localize`:@@settings.audit.period.24h:Últimas 24 horas`;
    case '7d':
      return $localize`:@@settings.audit.period.7d:Últimos 7 dias`;
    case '30d':
      return $localize`:@@settings.audit.period.30d:Últimos 30 dias`;
    default:
      return $localize`:@@settings.audit.period.any:Todo o período`;
  }
}

/** Quem agiu: o nome atual da conta; nunca o e-mail. */
export function actorLabel(item: AuditItem): string {
  if (!item.actor) return $localize`:@@settings.audit.actor.none:Sem conta`;
  return item.actor.displayName ?? $localize`:@@settings.audit.actor.deleted:Conta apagada`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** O número que vem depois de `chave=` num alvo da trilha (`length=5`); `null` se o formato não é esse. */
function countAfter(target: string, key: string): number | null {
  const prefix = `${key}=`;
  if (!target.startsWith(prefix)) return null;
  const value = Number(target.slice(prefix.length));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * O alvo da ação em palavras: a conta sobre a qual se agiu, o app, a tecla, o computador. Identificador opaco (id de
 * convite, de passkey, de pareamento) não ajuda ninguém a ler e fica de fora, assim como qualquer alvo cujo formato a
 * tela não conhece.
 */
export function describeTarget(item: AuditItem): string | null {
  if (item.targetAccount) {
    return (
      item.targetAccount.displayName ?? $localize`:@@settings.audit.actor.deleted:Conta apagada`
    );
  }
  const target = item.target?.trim();
  if (!target) return null;

  switch (item.action) {
    case 'tv.key': {
      const key = target.split('/')[0].replaceAll('_', ' ').toLowerCase();
      return $localize`:@@settings.audit.target.key:Tecla ${key}:key:`;
    }
    case 'tv.text': {
      const length = countAfter(target, 'length');
      if (length === null) return null;
      return length === 1
        ? $localize`:@@settings.audit.target.char-one:1 caractere`
        : $localize`:@@settings.audit.target.char-many:${length}:count: caracteres`;
    }
    case 'tv.shortcuts.reorder': {
      const count = countAfter(target, 'count');
      if (count === null) return null;
      return count === 1
        ? $localize`:@@settings.audit.target.shortcut-one:1 atalho`
        : $localize`:@@settings.audit.target.shortcut-many:${count}:count: atalhos`;
    }
    case 'tv.app.launch':
      return $localize`:@@settings.audit.target.app:App ${target}:app:`;
    case 'tv.cleanup.setting':
      return target === 'background-app-closing=on'
        ? $localize`:@@settings.audit.target.close-background-on:Ligado`
        : target === 'background-app-closing=off'
          ? $localize`:@@settings.audit.target.close-background-off:Desligado`
          : null;
    case 'tv.config.bind':
      return $localize`:@@settings.audit.target.computer:Computador ${target}:computer:`;
    case 'step_up_succeeded':
    case 'step_up_failed':
      return capitalize(stepUpActionLabel(target));
    case 'pairing_started':
    case 'pairing_approved':
    case 'pairing_denied':
    case 'pairing_expired':
    case 'pairing_token_issued':
    case 'agent_revoked':
    case 'agent_logs_viewed':
    case 'agent_update_requested':
    case 'agent_restart_requested':
    case 'agent_rollback_requested':
    case 'agent_offline':
    case 'agent_online':
      // Nesta fonte o alvo é o nome do aparelho no cadastro (texto de gente).
      return target;
    default:
      return null;
  }
}

/** Separa `"+a,b|-c"` (o que entrou e o que saiu numa mudança de permissões) em duas listas. */
function permissionChanges(detail: string): { added: string[]; removed: string[] } {
  const part = (prefix: string) =>
    detail
      .split('|')
      .find((piece) => piece.startsWith(prefix))
      ?.slice(1)
      .split(',')
      .filter((permission) => permission.length > 0) ?? [];
  return { added: part('+'), removed: part('-') };
}

/**
 * O que mudou, quando a linha carrega isso (permissões trocadas, o que um convite concede, o tamanho de uma
 * exportação). Só o que a tela sabe dizer em palavras: o detalhe cru nunca aparece.
 */
export function describeChange(item: AuditItem): string | null {
  const detail = item.detail?.trim();
  if (!detail) return null;

  switch (item.action) {
    case 'permissions_changed': {
      const { added, removed } = permissionChanges(detail);
      const parts: string[] = [];
      const gained = permissionLabels(added);
      const lost = permissionLabels(removed);
      if (gained.length > 0) {
        parts.push(
          $localize`:@@settings.audit.change.gained:Passou a poder: ${gained.join(', ')}:list:`,
        );
      }
      if (lost.length > 0) {
        parts.push(
          $localize`:@@settings.audit.change.lost:Deixou de poder: ${lost.join(', ')}:list:`,
        );
      }
      return parts.length > 0 ? parts.join('. ') : null;
    }
    case 'guest_invite_created': {
      const labels = permissionLabels(detail.split(',').filter((p) => p.length > 0));
      return labels.length > 0
        ? $localize`:@@settings.audit.change.invite:Acesso do convite: ${labels.join(', ')}:list:`
        : null;
    }
    case 'audit_exported': {
      const rows = countAfter(detail, 'rows');
      if (rows === null) return null;
      return rows === 1
        ? $localize`:@@settings.audit.change.rows-one:1 linha no arquivo`
        : $localize`:@@settings.audit.change.rows-many:${rows}:count: linhas no arquivo`;
    }
    default:
      return null;
  }
}

/** O nome do navegador e do aparelho a partir do `User-Agent`; `null` quando não há nada registrado. */
export function summarizeUserAgent(userAgent: string | null): string | null {
  const ua = userAgent?.trim();
  if (!ua) return null;

  const browser = browserOf(ua);
  const device = deviceOf(ua);
  if (browser && device) {
    return $localize`:@@settings.audit.device.browser-on:${browser}:browser: no ${device}:device:`;
  }
  if (browser ?? device) return browser ?? device;

  // Programas que não são navegador (o agente do computador, por exemplo) anunciam só "Nome/versão".
  const product = /^([A-Za-z][A-Za-z0-9._-]{1,29})\//.exec(ua)?.[1];
  return product && product !== 'Mozilla'
    ? product
    : $localize`:@@settings.audit.device.unknown:Aparelho não identificado`;
}

function browserOf(ua: string): string | null {
  if (/\b(Edg|EdgA|EdgiOS)\//.test(ua)) return 'Edge';
  if (/\b(OPR|OPiOS)\//.test(ua) || /\bOpera\b/.test(ua)) return 'Opera';
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'Firefox';
  if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/\b(CriOS|Chrome|Chromium)\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari';
  return null;
}

function deviceOf(ua: string): string | null {
  if (/\biPhone\b/.test(ua)) return 'iPhone';
  if (/\biPad\b/.test(ua)) return 'iPad';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\bCrOS\b/.test(ua)) return 'Chromebook';
  if (/\bWindows\b/.test(ua)) return 'Windows';
  if (/\bMacintosh\b/.test(ua)) return 'Mac';
  if (/\b(Linux|X11)\b/.test(ua)) return 'Linux';
  return null;
}

function daysText(days: number): string {
  return days === 1
    ? $localize`:@@settings.audit.retention.day:1 dia`
    : $localize`:@@settings.audit.retention.days:${days}:days: dias`;
}

/**
 * "Guardamos por N dias", numa frase só quando todas as trilhas em vista guardam o mesmo tempo; quando diferem (os
 * comandos da TV duram menos), a exceção vem entre parênteses. `modules` vazio = todas as trilhas. `null` se não há prazo
 * a dizer.
 */
export function retentionText(
  sources: AuditSources | null,
  modules: readonly string[],
): string | null {
  if (!sources) return null;
  const visible = sources.sources.filter(
    (source) => modules.length === 0 || modules.includes(source.module),
  );
  if (visible.length === 0) return null;

  const byDays = new Map<number, string[]>();
  for (const source of visible) {
    const days = Number(source.retentionDays);
    if (!Number.isFinite(days) || days <= 0) continue;
    byDays.set(days, [...(byDays.get(days) ?? []), moduleLabel(source.module)]);
  }
  if (byDays.size === 0) return null;
  if (byDays.size === 1) {
    const [days] = [...byDays.keys()];
    return $localize`:@@settings.audit.retention.one:Guardamos por ${daysText(days)}:days:`;
  }

  // O prazo mais longo é o geral; o que guarda menos (os comandos da TV) vem entre parênteses, com o nome da trilha.
  const [[longest], ...shorter] = [...byDays.entries()].sort(([a], [b]) => b - a);
  const exceptions = shorter
    .map(([days, labels]) => `${labels.join(', ')}: ${daysText(days)}`)
    .join('; ');
  return $localize`:@@settings.audit.retention.many:Guardamos por ${daysText(longest)}:days: (${exceptions}:exceptions:)`;
}

/**
 * Data e hora de uma linha no formato e no fuso do navegador. O ano só aparece quando não é o ano de `now` (a trilha
 * guarda meses, então uma data de dezembro lida em janeiro precisa dele).
 */
export function formatWhen(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** A data e a hora por extenso, com os segundos (a folha de detalhes). */
export function formatWhenFull(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'medium' }).format(date);
}
