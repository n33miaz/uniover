import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PageTopBar } from './page-top-bar';

@Component({
  imports: [PageTopBar],
  template: `<!-- eslint-disable @angular-eslint/template/i18n -->
    <app-page-top-bar title="Configurações" backLabel="Voltar" (back)="backCount = backCount + 1">
      <button pageTopBarActions type="button">Mais opções</button>
    </app-page-top-bar> `,
})
class HostWithActions {
  backCount = 0;
}

@Component({
  imports: [PageTopBar],
  template: `<!-- eslint-disable @angular-eslint/template/i18n --><app-page-top-bar
      title="Perfil"
      backLabel="Voltar"
    />`,
})
class HostWithoutActions {}

describe('PageTopBar', () => {
  let fixture: ComponentFixture<HostWithActions>;
  let el: HTMLElement;

  beforeEach(() => {
    fixture = TestBed.createComponent(HostWithActions);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  it('renders the title in the middle column between two side areas', () => {
    const head = el.querySelector('.head')!;
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Configurações');
    expect(head.children).toHaveLength(3);
    expect(head.children[1].querySelector('h1')).not.toBeNull();
  });

  it('emits back when the circular button is pressed', () => {
    el.querySelector<HTMLButtonElement>('.back')!.click();
    expect(fixture.componentInstance.backCount).toBe(1);
  });

  it('projects the actions on the right', () => {
    const action = el.querySelector('.actions [pageTopBarActions]');
    expect(action?.textContent?.trim()).toBe('Mais opções');
  });

  it('shows no back button when there is no back label, keeping the side reserved', () => {
    @Component({
      imports: [PageTopBar],
      template: `<!-- eslint-disable @angular-eslint/template/i18n --><app-page-top-bar
          title="Início"
        />`,
    })
    class HostWithoutBack {}
    const bare = TestBed.createComponent(HostWithoutBack);
    bare.detectChanges();
    const el2 = bare.nativeElement as HTMLElement;
    expect(el2.querySelector('.back')).toBeNull();
    expect(el2.querySelector('.head')?.children).toHaveLength(3);
  });

  it('keeps the actions side reserved when there is no action', () => {
    const empty = TestBed.createComponent(HostWithoutActions);
    empty.detectChanges();
    const actions = (empty.nativeElement as HTMLElement).querySelector('.actions');
    expect(actions).not.toBeNull();
    expect(actions!.childElementCount).toBe(0);
  });
});
