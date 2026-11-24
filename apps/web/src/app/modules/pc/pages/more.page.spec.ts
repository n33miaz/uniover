import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PcStore } from '../data/pc-store';
import { PcScreenAccess } from '../data/screen-access';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { MorePage } from './more.page';

describe('MorePage', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<MorePage>>;
  let root: HTMLElement;
  const screenAllowed = signal(false);

  beforeEach(() => {
    store = createFakePcStore();
    screenAllowed.set(false);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: PcStore, useValue: store },
        { provide: PcScreenAccess, useValue: { allowed: screenAllowed } },
      ],
    });
    fixture = TestBed.createComponent(MorePage);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => fixture.destroy());

  it('has one wide row per subject, with no explanatory text', () => {
    const rows = [...root.querySelectorAll('.row')].map((row) => row.textContent?.trim());
    expect(rows).toEqual(['Controles', 'Energia', 'Ajustes']);
    expect(root.querySelectorAll('p')).toHaveLength(0);
  });

  it('Controls and Power are links to their own screens', () => {
    expect([...root.querySelectorAll('a.row')].map((a) => a.getAttribute('href'))).toEqual([
      '/pc/controles',
      '/pc/energia',
    ]);
  });

  it('shows the clipboard row only for a PC that declared it', () => {
    store.capabilities.set(['pc.clipboard.v1']);
    fixture.detectChanges();
    expect([...root.querySelectorAll('.row')].map((row) => row.textContent?.trim())).toEqual([
      'Controles',
      'Energia',
      'Área de Transferência',
      'Ajustes',
    ]);
    expect(root.querySelector('a[href="/pc/area-de-transferencia"]')).not.toBeNull();
  });

  it('shows the PC screen row only when the screen is allowed', () => {
    expect(root.querySelector('a[href="/pc/tela"]')).toBeNull();
    screenAllowed.set(true);
    fixture.detectChanges();
    expect(root.querySelector('a[href="/pc/tela"]')?.textContent?.trim()).toBe('Tela do PC');
  });

  it('Settings opens the settings sheet', async () => {
    expect(root.querySelector('dialog')).toBeNull();
    root.querySelector<HTMLButtonElement>('button.row')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });
});
