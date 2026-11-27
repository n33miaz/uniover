import { inject } from '@angular/core';
import { type CanActivateFn, Router, type Routes } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { homeFor } from '../../core/auth/guest-home';
import { SessionState } from '../../core/session/session-state';
import { clearPendingShare, markInterruptedShare } from './pending-share-storage';
import { canAccessVideoInbox } from './video-inbox.model';

// A caixa é local. Só se abre o IndexedDB quando há uma conta e permissão conhecidas.
const videoInboxGuard: CanActivateFn = (route, state) => {
  const session = inject(SessionState);
  const auth = inject(AuthService);
  const router = inject(Router);
  const accountId = session.accountId();
  const share = route.queryParamMap.get('share');
  if (!accountId) {
    if (auth.status() !== 'authenticated') return auth.loginUrlTree(state.url);
    if (share) markInterruptedShare(share, null);
    return router.createUrlTree([homeFor()]);
  }
  const permissions = session.knownPermissions();
  if (canAccessVideoInbox(session.role(), permissions)) {
    return true;
  }
  if (share) {
    // Permissão ainda desconhecida: o registro fica para a volta. Negada: apaga só o desta intenção.
    if (permissions == null) markInterruptedShare(share, accountId);
    else clearPendingShare(share);
  }
  return router.createUrlTree([homeFor()]);
};

export const VIDEOS_ROUTES: Routes = [
  {
    path: '',
    canActivate: [videoInboxGuard],
    loadComponent: () => import('./video-inbox.page').then((m) => m.VideoInboxPage),
  },
];
