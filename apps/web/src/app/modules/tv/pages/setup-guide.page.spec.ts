import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SetupGuidePage } from './setup-guide.page';

describe('SetupGuidePage', () => {
  async function render() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(SetupGuidePage);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it('guides the owner through the actual PC and TV approval flow', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const next = () => root.querySelector<HTMLButtonElement>('.steps .primary')!.click();

    expect(root.querySelector('a[href="/ajustes/dispositivos"]')).not.toBeNull();
    next();
    await fixture.whenStable();
    expect(root.textContent).toContain('escaneie o QR');
    expect(root.querySelector('a[href="/conectar"]')).not.toBeNull();
    next();
    await fixture.whenStable();
    expect(root.textContent).toContain('Ela deve aparecer no controle');
    expect(root.querySelector('a[href="/ajustes/sistema"]')).not.toBeNull();
  });

  it('offers the three Remote Service checks without claiming automatic diagnosis', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    for (let step = 0; step < 3; step++) {
      root.querySelector<HTMLButtonElement>('.steps .primary')!.click();
      await fixture.whenStable();
    }

    expect(
      Array.from(root.querySelectorAll('.diagnostics summary')).map((item) => item.textContent),
    ).toEqual(['Serviço Desatualizado', 'Serviços Parados', 'Caixa de TV']);
    expect(root.textContent).toContain('não consegue determinar sozinho');
    expect(root.querySelector('a[href="/tv"]')).not.toBeNull();
  });
});
