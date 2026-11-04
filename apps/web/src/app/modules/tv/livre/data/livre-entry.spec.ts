import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import { SessionState } from '../../../../core/session/session-state';
import { TvApi } from '../../data/tv-api';
import { TvSelection } from '../../data/tv-selection';
import { makeTv } from '../../tv-test-kit';
import { TvLivreEntry } from './livre-entry';
import { TV_LIVRE_CAPABILITY } from './livre-types';

const LIVRE_TV = makeTv('casa', {
  isDefault: true,
  capabilities: ['tv.adb', TV_LIVRE_CAPABILITY],
});
const SAMSUNG = makeTv('sala', { kind: 'samsung', capabilities: ['tv.kind.samsung'] });

describe('TvLivreEntry', () => {
  const tvs = vi.fn();
  const online = signal(true);
  let entry: TvLivreEntry;
  let now = 1_000_000;

  function signIn(role: 'owner' | 'guest', id = 'conta') {
    TestBed.inject(SessionState).setUser({
      id,
      email: 'conta@exemplo.com',
      displayName: 'Conta',
      role,
    });
  }

  beforeEach(() => {
    tvs.mockReset();
    online.set(true);
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    TestBed.configureTestingModule({
      providers: [
        { provide: TvApi, useValue: { tvs } },
        { provide: ConnectivityService, useValue: { online } },
      ],
    });
    entry = TestBed.inject(TvLivreEntry);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('available', () => {
    it('is off until the list of TVs has said that the current one declares the capability', () => {
      signIn('owner');
      expect(entry.available()).toBe(false);
      TestBed.inject(TvSelection).setTvs([LIVRE_TV]);
      expect(entry.available()).toBe(true);
    });

    it('is off for a TV that does not declare it, even when it has other capabilities', () => {
      signIn('owner');
      TestBed.inject(TvSelection).setTvs([SAMSUNG]);
      expect(entry.available()).toBe(false);
      TestBed.inject(TvSelection).setTvs([makeTv('vazia', { capabilities: [] })]);
      expect(entry.available()).toBe(false);
    });

    it('follows the TV in use when there are several', () => {
      signIn('owner');
      const selection = TestBed.inject(TvSelection);
      selection.setTvs([LIVRE_TV, SAMSUNG]);
      expect(entry.available()).toBe(true);
      selection.select('sala');
      expect(entry.available()).toBe(false);
      selection.select('casa');
      expect(entry.available()).toBe(true);
    });

    it('is off for a guest, even with a TV that supports it', () => {
      signIn('guest');
      TestBed.inject(TvSelection).setTvs([LIVRE_TV]);
      expect(entry.available()).toBe(false);
    });
  });

  describe('refresh', () => {
    it('asks for the list of TVs and gives it to the selection', async () => {
      signIn('owner');
      tvs.mockResolvedValue([LIVRE_TV]);
      entry.refresh();
      await vi.waitFor(() => expect(entry.available()).toBe(true));
      expect(tvs).toHaveBeenCalledTimes(1);
    });

    it('asks at most once a minute for the same account', async () => {
      signIn('owner');
      tvs.mockResolvedValue([LIVRE_TV]);
      entry.refresh();
      await vi.waitFor(() => expect(tvs).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(entry.available()).toBe(true));
      now += 30_000;
      entry.refresh();
      await Promise.resolve();
      expect(tvs).toHaveBeenCalledTimes(1);
      now += 31_000;
      entry.refresh();
      await vi.waitFor(() => expect(tvs).toHaveBeenCalledTimes(2));
    });

    it('never asks without an account or for a guest', async () => {
      tvs.mockResolvedValue([LIVRE_TV]);
      entry.refresh();
      signIn('guest', 'convidada');
      entry.refresh();
      await Promise.resolve();
      expect(tvs).not.toHaveBeenCalled();
    });

    it('does not ask while offline', async () => {
      signIn('owner');
      online.set(false);
      entry.refresh();
      await Promise.resolve();
      expect(tvs).not.toHaveBeenCalled();
    });

    it('hides the card, without rejecting, when the list cannot be read', async () => {
      signIn('owner');
      tvs.mockRejectedValue(new Error('servidor antigo'));
      entry.refresh();
      await vi.waitFor(() => expect(tvs).toHaveBeenCalled());
      await Promise.resolve();
      expect(entry.available()).toBe(false);
      // A próxima abertura pode tentar de novo: a falha não conta como "já perguntei".
      tvs.mockResolvedValue([LIVRE_TV]);
      entry.refresh();
      await vi.waitFor(() => expect(entry.available()).toBe(true));
    });

    it('drops a list that arrives after the account changed', async () => {
      signIn('owner', 'primeira');
      let late!: (list: unknown) => void;
      tvs.mockReturnValue(new Promise((resolve) => (late = resolve)));
      entry.refresh();
      signIn('owner', 'segunda');
      late([LIVRE_TV]);
      await new Promise((resolve) => setTimeout(resolve));
      expect(entry.available()).toBe(false);
    });
  });
});
