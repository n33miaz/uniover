import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TvPageSkeleton } from './tv-page-skeleton';

describe('TvPageSkeleton', () => {
  let fixture: ComponentFixture<TvPageSkeleton>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TvPageSkeleton] });
    fixture = TestBed.createComponent(TvPageSkeleton);
    fixture.detectChanges();
  });

  it('keeps the remote layout while the TV state is loading', () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.shortcuts .ui-skeleton')).toHaveLength(3);
    expect(root.querySelector('.ring .disk')).not.toBeNull();
    expect(root.querySelectorAll('.keys .ui-skeleton')).toHaveLength(8);
    expect(root.querySelectorAll('.pill')).toHaveLength(2);
  });
});
