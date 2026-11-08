import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OfflineGuidePage } from './offline-guide.page';

describe('OfflineGuidePage', () => {
  async function render() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(OfflineGuidePage);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('covers the two cases and the preparation, each title on one short line', async () => {
    const root = await render();
    expect([...root.querySelectorAll('h2')].map((title) => title.textContent?.trim())).toEqual([
      'Só a internet caiu',
      'O roteador desligou',
      'Deixe preparado',
    ]);
  });

  it('says to share the internet by USB while the PC stays on the home Wi-Fi', async () => {
    const root = await render();
    const steps = [...root.querySelectorAll('[aria-labelledby="offline-a"] li')].map((step) =>
      step.textContent?.trim(),
    );
    expect(steps).toEqual([
      'Ligue o celular ao PC por cabo USB.',
      'No celular, ative o compartilhamento de internet por USB.',
      'Deixe o PC no Wi-Fi de casa.',
    ]);
  });

  it('tells the phone to copy the home network, never to change the home password', async () => {
    const root = await render();
    const text = root.querySelector('[aria-labelledby="offline-b"]')!.textContent!;
    expect(text).toContain('mesmo nome e a mesma senha do Wi-Fi de casa');
    expect(text).toContain('iPhone:');
    expect(text).toContain('Android:');
    expect(text).toContain('Maximizar compatibilidade (2,4 GHz)');
    expect(text).not.toMatch(/troque a senha|mude a senha|altere a senha/i);
  });

  it('is only text: no button sends anything to the TV, and the way back is a link', async () => {
    const root = await render();
    expect(root.querySelectorAll('button')).toHaveLength(0);
    expect(root.querySelector('a[href="/tv"]')).not.toBeNull();
  });
});
