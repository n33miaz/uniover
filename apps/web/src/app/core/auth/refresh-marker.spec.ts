import { StorageRefreshMarker } from './refresh-marker';

describe('StorageRefreshMarker', () => {
  // Os arquivos de teste dividem o mesmo `localStorage`: outro arquivo pode ter deixado a marca de renovação armada.
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is set until cleared, and shared through the storage (another page or tab sees it)', () => {
    const marker = new StorageRefreshMarker();
    expect(marker.isSet()).toBe(false);
    marker.set();
    expect(marker.isSet()).toBe(true);
    expect(new StorageRefreshMarker().isSet()).toBe(true);
    marker.clear();
    expect(marker.isSet()).toBe(false);
    expect(new StorageRefreshMarker().isSet()).toBe(false);
  });

  it('keeps the mark in memory when the storage is blocked (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const marker = new StorageRefreshMarker();
    expect(marker.isSet()).toBe(false);
    marker.set();
    expect(marker.isSet()).toBe(true);
    marker.clear();
    expect(marker.isSet()).toBe(false);
  });
});
