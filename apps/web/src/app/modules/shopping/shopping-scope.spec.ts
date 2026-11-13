import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ShoppingActions } from './shopping-actions';
import { ShoppingScope } from './shopping-scope';
import { ShoppingSession } from './shopping-session';

@Component({ selector: 'app-details-probe', template: '<span class="probe"></span>' })
class DetailsProbe {}

describe('ShoppingScope', () => {
  it('keeps the routed screens in place when the device storage did not open, so Detalhes still works', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: ShoppingScope, children: [{ path: 'detalhes', component: DetailsProbe }] },
        ]),
      ],
    });
    TestBed.overrideComponent(ShoppingScope, {
      set: {
        providers: [
          {
            provide: ShoppingSession,
            useValue: { store: signal(null), failed: signal(true), retry: () => undefined },
          },
          { provide: ShoppingActions, useValue: {} },
        ],
      },
    });

    const harness = await RouterTestingHarness.create('/detalhes');

    expect((harness.routeNativeElement as HTMLElement).querySelector('.probe')).not.toBeNull();
  });
});
