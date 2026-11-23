import { inject } from '@angular/core';
import { type CanActivateFn, Router, type Routes } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { homeFor } from '../../core/auth/guest-home';
import { SessionState } from '../../core/session/session-state';
import { clearPendingShare } from './pending-share-storage';
import { canAccessVideoInbox } from './video-inbox.model';

// A caixa é local. Só se abre o IndexedDB quando há uma conta e permissão conhecidas.
const videoInboxGuard: CanActivateFn = () => {
  const session = inject(SessionState);
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!session.accountId()) {
    return auth.status() === 'authenticated'
      ? router.createUrlTree([homeFor()])
      : auth.loginUrlTree('/videos');
  }
  const permissions = session.knownPermissions();
  if (canAccessVideoInbox(session.role(), permissions)) {
    return true;
  }
  if (permissions != null) clearPendingShare();
  return router.createUrlTree([homeFor()]);
};

export const VIDEOS_ROUTES: Routes = [
  {
    path: '',
    canActivate: [videoInboxGuard],
    loadComponent: () => import('./video-inbox.page').then((m) => m.VideoInboxPage),
  },
];
