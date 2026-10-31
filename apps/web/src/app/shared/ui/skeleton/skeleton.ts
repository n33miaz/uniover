import { Directive } from '@angular/core';

/** Superfície de espera reutilizável: só a forma aparece enquanto o dado ainda não chegou. */
@Directive({
  selector: '[appSkeleton]',
  host: {
    class: 'ui-skeleton',
    'aria-hidden': 'true',
  },
})
export class Skeleton {}
