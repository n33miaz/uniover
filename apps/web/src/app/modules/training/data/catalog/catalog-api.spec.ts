import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CatalogApi, EXERCISES_PATH, exercisePath, exerciseStepPath } from './catalog-api';

describe('CatalogApi', () => {
  let api: CatalogApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(CatalogApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the credits of the catalog', async () => {
    const credits = api.credits();
    const request = http.expectOne('/api/v1/training/catalog/credits');
    expect(request.request.method).toBe('GET');
    request.flush({
      sources: [{ source: 'free_exercise_db', count: 300, license: 'Unlicense', licenseUrl: null }],
      wgerAuthors: [],
    });
    expect((await credits).sources.map((source) => source.source)).toEqual(['free_exercise_db']);
  });

  it('builds the API paths in one place, always under /api/', () => {
    expect(EXERCISES_PATH).toBe('/api/v1/training/exercises');
    expect(exercisePath('abc')).toBe('/api/v1/training/exercises/abc');
    expect(exerciseStepPath('abc')).toBe('/api/v1/training/exercises/abc/step');
    expect(exercisePath('a/b')).toBe('/api/v1/training/exercises/a%2Fb');
  });
});
