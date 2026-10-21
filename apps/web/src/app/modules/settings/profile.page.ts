import {
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
  ElementRef,
} from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import {
  DISPLAY_NAME_INPUT_LIMIT,
  DisplayNameFailure,
  MAX_DISPLAY_NAME,
  describeDisplayNameFailure,
  displayNameCounterText,
  displayNameIssue,
  displayNameIssueText,
  displayNameLength,
  normalizeDisplayName,
} from '../../core/auth/display-name';
import { SessionState } from '../../core/session/session-state';
import { SettingsGlyph } from './settings-glyph';
import { permissionLabels, roleLabel } from './settings-titles';

/**
 * Perfil: quem a pessoa é para o app. O nome pode ser trocado a qualquer hora (campo, "Salvar" e o resultado ali mesmo,
 * sem navegar); o e-mail é só leitura; o papel aparece como "Administrador" ou "Convidado" e, para o convidado, a lista do
 * que ele pode fazer, lida das permissões que a API devolveu. Aqui também está o estado da sessão e o "Sair".
 *
 * Serve a todos os papéis e só usa a conta da própria pessoa (`/me`): nenhuma chamada a rota de administrador.
 */
@Component({
  selector: 'app-profile-page',
  imports: [SettingsGlyph],
  templateUrl: './profile.page.html',
  styleUrl: './profile.page.css',
})
export class ProfilePage {
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);

  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly user = this.session.user;
  protected readonly status = this.session.status;
  protected readonly role = this.session.role;
  protected readonly roleText = computed(() => roleLabel(this.role()));
  protected readonly isGuest = this.session.isGuest;
  protected readonly abilities = computed(() => permissionLabels(this.session.permissions()));

  protected readonly inputLimit = DISPLAY_NAME_INPUT_LIMIT;

  /** O texto do campo: recomeça no nome da conta sempre que ele muda (ao carregar e depois de salvar). */
  protected readonly name = linkedSignal(() => this.user()?.displayName ?? '');
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly failure = signal<DisplayNameFailure | null>(null);
  protected readonly submitted = signal(false);
  protected readonly touched = signal(false);

  protected readonly loggingOut = signal(false);
  protected readonly logoutUnconfirmed = signal(false);

  protected readonly counter = computed(() => displayNameCounterText(this.name()));
  protected readonly overLimit = computed(() => displayNameLength(this.name()) > MAX_DISPLAY_NAME);
  protected readonly dirty = computed(
    () => normalizeDisplayName(this.name()) !== (this.user()?.displayName ?? ''),
  );

  protected readonly nameError = computed(() => {
    const issue = displayNameIssue(this.name());
    if (issue && (issue === 'too-long' || this.touched() || this.submitted())) {
      return displayNameIssueText(issue);
    }
    const failure = this.failure();
    return failure?.kind === 'field' ? failure.field : null;
  });

  protected readonly banner = computed(() => {
    const failure = this.failure();
    return failure && failure.kind !== 'field' ? failure : null;
  });

  protected readonly sessionText = computed(() => {
    switch (this.status()) {
      case 'authenticated':
        return $localize`:@@settings.session.active:Sessão ativa.`;
      case 'pending':
        return $localize`:@@settings.session.pending:Sessão a confirmar: sem conexão com o servidor. Nada foi apagado e o app confirma sozinho quando a conexão voltar.`;
      case 'anonymous':
        return $localize`:@@settings.session.anonymous:Sem sessão.`;
      default:
        return $localize`:@@settings.session.unknown:Verificando a sessão…`;
    }
  });

  /** Letra do avatar: a primeira do nome (ou do e-mail, se o nome vier vazio). */
  protected readonly initial = computed(() => {
    const user = this.user();
    return (user?.displayName.trim() || user?.email || '?').charAt(0).toLocaleUpperCase('pt-BR');
  });

  protected edit(value: string): void {
    this.name.set(value);
    this.saved.set(false);
    this.failure.set(null);
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.submitted.set(true);
    this.saved.set(false);
    this.failure.set(null);
    if (displayNameIssue(this.name())) {
      this.nameInput()?.nativeElement.focus();
      return;
    }

    this.saving.set(true);
    try {
      await this.auth.updateDisplayName(normalizeDisplayName(this.name()));
      this.submitted.set(false);
      this.touched.set(false);
      this.saved.set(true);
    } catch (error) {
      const failure = describeDisplayNameFailure(error);
      this.failure.set(failure);
      if (failure.kind === 'field') this.nameInput()?.nativeElement.focus();
    } finally {
      this.saving.set(false);
    }
  }

  protected async logout(): Promise<void> {
    this.loggingOut.set(true);
    try {
      this.logoutUnconfirmed.set(!(await this.auth.logout()));
    } finally {
      this.loggingOut.set(false);
    }
  }
}
