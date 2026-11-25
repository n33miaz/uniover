import { Injectable, computed, inject } from '@angular/core';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { userCan } from '../../../core/session/access';
import { SessionState } from '../../../core/session/session-state';
import { PC_ABS_CAPABILITY } from './screen-touch';

/** O que o PC declara quando a tela está ligada nele (`pc_screen`). */
export const PC_SCREEN_CAPABILITY = 'pc.screen.v1';
export const PC_SCREEN_PERMISSION = 'pc:screen';

/**
 * Se a conta pode ver a tela do PC: só o dono, com a permissão `pc:screen` e com o PC declarando a capacidade (ou seja,
 * com `pc_screen` ligado nele). Sem isso a entrada e a página ficam escondidas.
 */
@Injectable({ providedIn: 'root' })
export class PcScreenAccess {
  private readonly availability = inject(PcAvailability);
  private readonly session = inject(SessionState);

  readonly allowed = computed(
    () =>
      this.availability.capabilities().includes(PC_SCREEN_CAPABILITY) &&
      this.session.isAuthenticated() &&
      this.session.role() === 'owner' &&
      userCan(this.session.user(), PC_SCREEN_PERMISSION),
  );

  /** O PC também entende o toque na imagem (`pc.abs.v1`): sem isso a tela só se vê. */
  readonly touch = computed(
    () => this.allowed() && this.availability.capabilities().includes(PC_ABS_CAPABILITY),
  );
}
