import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withNavigationErrorHandler } from '@angular/router';
import {
  ChunkAwareErrorHandler,
  isChunkLoadError,
  recoverFromChunkNavigationError,
} from './chunk-error';
import { ClientTelemetry } from '../telemetry/client-telemetry';
import { PwaUpdateService } from './pwa-update.service';

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/chunk-ABC.js',
    'error loading dynamically imported module: https://x/chunk-ABC.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /styles-ABC.css',
    'Loading chunk 12 failed.',
  ])('recognizes the browser message "%s"', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
    expect(isChunkLoadError(message)).toBe(true);
  });

  it('recognizes the error wrapped in cause, rejection or ngOriginalError', () => {
    const inner = new TypeError('Failed to fetch dynamically imported module: /chunk-A.js');
    expect(isChunkLoadError(new Error('rota', { cause: inner }))).toBe(true);
    expect(isChunkLoadError({ rejection: inner })).toBe(true);
    expect(isChunkLoadError({ ngOriginalError: inner })).toBe(true);
    const named = new Error('x');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('leaves every other error alone', () => {
    expect(isChunkLoadError(new Error('Http failure response: 500'))).toBe(false);
    expect(isChunkLoadError(new TypeError('x is not a function'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
    expect(isChunkLoadError({ message: 'outra coisa' })).toBe(false);
    // Uma cadeia de causas sem fim não trava a leitura.
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isChunkLoadError(loop)).toBe(false);
  });
});

describe('chunk recovery wiring', () => {
  let recover: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recover = vi.fn().mockReturnValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: PwaUpdateService, useValue: { recoverFromStaleShell: recover } },
        { provide: ErrorHandler, useClass: ChunkAwareErrorHandler },
      ],
    });
  });

  it('recovers when the global handler sees a missing chunk, logging only a warning, never an error', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = TestBed.inject(ErrorHandler);
    handler.handleError(new TypeError('Failed to fetch dynamically imported module: /chunk-A.js'));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(logged).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledTimes(1);
    logged.mockRestore();
    warned.mockRestore();
  });

  it('logs the error normally when the loop guard denies the recovery', () => {
    recover.mockReturnValue(false);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.inject(ErrorHandler).handleError(new TypeError('Importing a module script failed.'));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('does not touch other errors', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.inject(ErrorHandler).handleError(new Error('outro erro'));
    expect(recover).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('registers an app error for the owner with the class name only, never the message', () => {
    const record = vi.spyOn(TestBed.inject(ClientTelemetry), 'recordError');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new TypeError('a senha digitada era 1234');
    TestBed.inject(ErrorHandler).handleError(error);
    expect(record).toHaveBeenCalledWith(error);
    logged.mockRestore();
  });

  it('does not register a missing chunk that the recovery handled', () => {
    const record = vi.spyOn(TestBed.inject(ClientTelemetry), 'recordError');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    TestBed.inject(ErrorHandler).handleError(
      new TypeError('Failed to fetch dynamically imported module: /chunk-A.js'),
    );
    expect(record).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it('a telemetry that breaks never changes how the error is handled', () => {
    vi.spyOn(TestBed.inject(ClientTelemetry), 'recordError').mockImplementation(() => {
      throw new Error('quebrou');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => TestBed.inject(ErrorHandler).handleError(new Error('x'))).not.toThrow();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('recovers when a lazy route fails to load its chunk', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: PwaUpdateService, useValue: { recoverFromStaleShell: recover } },
        provideRouter(
          [
            {
              path: 'sumiu',
              loadComponent: () =>
                Promise.reject(
                  new TypeError('Failed to fetch dynamically imported module: /chunk-A.js'),
                ),
            },
            {
              path: 'quebrou',
              loadComponent: () => Promise.reject(new Error('Http failure response: 500')),
            },
          ],
          withNavigationErrorHandler(recoverFromChunkNavigationError),
        ),
      ],
    });
    const router = TestBed.inject(Router);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await router.navigateByUrl('/sumiu').catch(() => undefined);
    expect(recover).toHaveBeenCalledTimes(1);
    // Engolido pela recuperação, mas registrado.
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();
    expect(recover).toHaveBeenCalledWith('/sumiu');
    await router.navigateByUrl('/quebrou').catch(() => undefined);
    expect(recover).toHaveBeenCalledTimes(1);
  });
});
