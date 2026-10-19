import { CanActivateFn } from '@angular/router';

/** Provisório: libera tudo. A proteção real (sessão em memória e renovação) substitui este arquivo. */
export const authGuard: CanActivateFn = () => true;
