import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SettingsPageSkeleton } from './settings-page-skeleton';

describe('SettingsPageSkeleton', () => {
  let fixture: ComponentFixture<SettingsPageSkeleton>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SettingsPageSkeleton] });
    fixture = TestBed.createComponent(SettingsPageSkeleton);
    fixture.componentRef.setInput('label', 'Carregando');
    fixture.componentRef.setInput('marker', 'settings');
  });

  it('draws the setting groups while the settings list is waiting', () => {
    fixture.componentRef.setInput('kind', 'list');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.group')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('.segments [appSkeleton]')).toHaveLength(3);
  });

  it('draws the identity, form, abilities and session areas for the profile', () => {
    fixture.componentRef.setInput('kind', 'profile');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.field')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.identity .avatar')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.card')).toHaveLength(2);
  });

  it('draws three theme choices and the installation line for appearance', () => {
    fixture.componentRef.setInput('kind', 'appearance');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.themes .theme')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('.install')).not.toBeNull();
  });
});
