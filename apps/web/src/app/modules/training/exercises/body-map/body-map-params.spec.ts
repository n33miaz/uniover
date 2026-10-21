import { convertToParamMap } from '@angular/router';
import { parseBodyMapParams, toBodyMapQuery } from './body-map-params';

const parse = (params: Record<string, string>) => parseBodyMapParams(convertToParamMap(params));

describe('body map address', () => {
  it('opens on the front, with no muscle, when the address has nothing', () => {
    expect(parse({})).toEqual({ face: 'front', muscle: '' });
  });

  it('reads the face and the open muscle', () => {
    expect(parse({ face: 'back', muscle: 'lats' })).toEqual({ face: 'back', muscle: 'lats' });
    expect(parse({ face: 'front', muscle: 'chest' })).toEqual({ face: 'front', muscle: 'chest' });
  });

  it('ignores a face or a muscle the app does not know', () => {
    expect(parse({ face: 'side', muscle: 'wings' })).toEqual({ face: 'front', muscle: '' });
  });

  it('opens on the face where a muscle with no face in the address can be touched', () => {
    expect(parse({ muscle: 'lats' })).toEqual({ face: 'back', muscle: 'lats' });
    expect(parse({ muscle: 'chest' })).toEqual({ face: 'front', muscle: 'chest' });
  });

  it('writes only what is not the default', () => {
    expect(toBodyMapQuery({ face: 'front', muscle: '' })).toBe('');
    expect(toBodyMapQuery({ face: 'back', muscle: '' })).toBe('face=back');
    expect(toBodyMapQuery({ face: 'back', muscle: 'lats' })).toBe('face=back&muscle=lats');
    expect(toBodyMapQuery({ face: 'front', muscle: 'chest' })).toBe('muscle=chest');
  });
});
