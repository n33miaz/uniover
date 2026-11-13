import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MorePage } from './more.page';

describe('MorePage', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<MorePage>>;
  let root: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
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

  it('Settings opens the settings sheet', async () => {
    expect(root.querySelector('dialog')).toBeNull();
    root.querySelector<HTMLButtonElement>('button.row')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });
});
