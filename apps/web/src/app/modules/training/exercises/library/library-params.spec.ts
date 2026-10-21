import { convertToParamMap } from '@angular/router';
import {
  EMPTY_LIBRARY_PARAMS,
  isFiltered,
  paramsKey,
  parseLibraryParams,
  toCatalogQuery,
  toQueryParams,
} from './library-params';

describe('library params', () => {
  it('reads the filters from the address', () => {
    const params = parseLibraryParams(
      convertToParamMap({ q: 'supino', group: 'chest', equipment: 'barbell' }),
    );
    expect(params).toEqual({ q: 'supino', group: 'chest', muscle: '', equipment: 'barbell' });
  });

  it('ignores ids the app does not know instead of filtering everything out', () => {
    const params = parseLibraryParams(
      convertToParamMap({ group: 'asas', muscle: 'nada', equipment: 'rede' }),
    );
    expect(params).toEqual(EMPTY_LIBRARY_PARAMS);
  });

  it('lets a muscle (from the body map) stand alone: the group is dropped', () => {
    const params = parseLibraryParams(convertToParamMap({ muscle: 'triceps', group: 'chest' }));
    expect(params).toMatchObject({ muscle: 'triceps', group: '' });
  });

  it('writes only the filled filters, and leaves the rest out of the address', () => {
    expect(toQueryParams({ q: 'supino', group: '', muscle: '', equipment: 'barbell' })).toEqual({
      q: 'supino',
      group: null,
      muscle: null,
      equipment: 'barbell',
    });
    expect(toQueryParams({ ...EMPTY_LIBRARY_PARAMS, q: '   ' })['q']).toBeNull();
  });

  it('builds the catalog query: empty fields do not filter', () => {
    expect(toCatalogQuery(EMPTY_LIBRARY_PARAMS)).toEqual({
      text: '',
      group: undefined,
      muscle: undefined,
      equipment: undefined,
    });
    expect(toCatalogQuery({ q: 'a', group: 'legs', muscle: '', equipment: 'cable' })).toMatchObject(
      { text: 'a', group: 'legs', equipment: 'cable' },
    );
  });

  it('knows when anything is filtering, and keys the filters so an echo can be told from news', () => {
    expect(isFiltered(EMPTY_LIBRARY_PARAMS)).toBe(false);
    expect(isFiltered({ ...EMPTY_LIBRARY_PARAMS, q: '  ' })).toBe(false);
    expect(isFiltered({ ...EMPTY_LIBRARY_PARAMS, muscle: 'chest' })).toBe(true);
    expect(paramsKey({ ...EMPTY_LIBRARY_PARAMS, q: 'a ' })).toBe(
      paramsKey({ ...EMPTY_LIBRARY_PARAMS, q: 'a' }),
    );
    expect(paramsKey({ ...EMPTY_LIBRARY_PARAMS, q: 'a' })).not.toBe(
      paramsKey(EMPTY_LIBRARY_PARAMS),
    );
  });
});
