import {
  assertionToJson,
  attestationToJson,
  base64urlToBuffer,
  bufferToBase64url,
  isWebAuthnAvailable,
  toCreationOptions,
  toRequestOptions,
} from './webauthn';

const bytes = (buffer: BufferSource) =>
  Array.from(
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding', () => {
    const original = new Uint8Array([0, 250, 251, 252, 253, 254, 255, 62, 63]);
    const text = bufferToBase64url(original);
    expect(text).not.toMatch(/[+/=]/);
    expect(bytes(base64urlToBuffer(text))).toEqual(Array.from(original));
  });

  it('decodes values with and without padding', () => {
    expect(bytes(base64urlToBuffer('AQID'))).toEqual([1, 2, 3]);
    expect(bytes(base64urlToBuffer('AQI'))).toEqual([1, 2]);
    expect(bytes(base64urlToBuffer('-_8'))).toEqual([251, 255]);
  });

  it('encodes a view that does not cover its whole buffer', () => {
    const whole = new Uint8Array([9, 1, 2, 3, 9]);
    expect(bufferToBase64url(whole.subarray(1, 4))).toBe('AQID');
  });
});

describe('toRequestOptions', () => {
  it('decodes the challenge and credential ids and requires user verification', () => {
    const options = toRequestOptions({
      challenge: 'AQID',
      timeout: 60000,
      rpId: 'localhost',
      allowCredentials: [{ type: 'public-key', id: 'BAUG', transports: ['internal'] }],
      userVerification: 'required',
    });
    expect(bytes(options.challenge)).toEqual([1, 2, 3]);
    expect(options.rpId).toBe('localhost');
    expect(options.timeout).toBe(60000);
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials).toHaveLength(1);
    expect(bytes(options.allowCredentials![0].id)).toEqual([4, 5, 6]);
    expect(options.allowCredentials![0].transports).toEqual(['internal']);
  });

  it('drops null and unknown fields instead of passing them on', () => {
    const options = toRequestOptions({
      status: 'ok',
      errorMessage: '',
      challenge: 'AQID',
      rpId: null,
      timeout: null,
      extensions: { appid: 'x' },
      allowCredentials: [{ type: 'public-key', id: 'BAUG', transports: null }],
    });
    expect(Object.keys(options).sort()).toEqual([
      'allowCredentials',
      'challenge',
      'userVerification',
    ]);
    expect(options.allowCredentials![0]).not.toHaveProperty('transports');
    expect(options.userVerification).toBe('required');
  });

  it('refuses options without a challenge', () => {
    expect(() => toRequestOptions({ rpId: 'x' })).toThrow();
    expect(() => toRequestOptions(null)).toThrow();
  });
});

describe('toCreationOptions', () => {
  const server = {
    rp: { name: 'UniOver', id: 'localhost' },
    user: { id: 'AQID', name: 'dono@exemplo.com', displayName: 'Dono' },
    challenge: 'BAUG',
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: 60000,
    excludeCredentials: [{ type: 'public-key', id: 'BwgJ' }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    attestation: 'none',
    extensions: null,
  };

  it('decodes user id, challenge and excluded credentials and keeps the rp id', () => {
    const options = toCreationOptions(server);
    expect(bytes(options.challenge)).toEqual([4, 5, 6]);
    expect(bytes(options.user.id)).toEqual([1, 2, 3]);
    expect(options.rp).toEqual({ name: 'UniOver', id: 'localhost' });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
    expect(bytes(options.excludeCredentials![0].id)).toEqual([7, 8, 9]);
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'preferred',
      userVerification: 'required',
    });
    expect(options.attestation).toBe('none');
    expect(options).not.toHaveProperty('extensions');
  });

  it('does not send a null rp id', () => {
    const options = toCreationOptions({ ...server, rp: { name: 'UniOver', id: null } });
    expect(options.rp).toEqual({ name: 'UniOver' });
  });

  it('refuses incomplete options', () => {
    expect(() => toCreationOptions({ ...server, user: null })).toThrow();
    expect(() => toCreationOptions({ ...server, challenge: undefined })).toThrow();
  });
});

describe('credential serialization', () => {
  const buffer = (...values: number[]) => new Uint8Array(values).buffer;

  it('serializes an assertion with base64url fields and a null userHandle', () => {
    const credential = {
      id: 'abc',
      rawId: buffer(1, 2, 3),
      type: 'public-key',
      response: {
        authenticatorData: buffer(4),
        clientDataJSON: buffer(5),
        signature: buffer(6),
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential;
    expect(assertionToJson(credential)).toEqual({
      id: 'abc',
      rawId: 'AQID',
      type: 'public-key',
      response: {
        authenticatorData: 'BA',
        clientDataJSON: 'BQ',
        signature: 'Bg',
        userHandle: null,
      },
      clientExtensionResults: {},
    });
  });

  it('serializes an attestation with transports', () => {
    const credential = {
      id: 'abc',
      rawId: buffer(1, 2, 3),
      type: 'public-key',
      response: {
        attestationObject: buffer(7),
        clientDataJSON: buffer(8),
        getTransports: () => ['internal'],
      },
      getClientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential;
    expect(attestationToJson(credential)).toEqual({
      id: 'abc',
      rawId: 'AQID',
      type: 'public-key',
      response: { attestationObject: 'Bw', clientDataJSON: 'CA', transports: ['internal'] },
      clientExtensionResults: {},
    });
  });
});

describe('isWebAuthnAvailable', () => {
  it('needs PublicKeyCredential and navigator.credentials', () => {
    expect(isWebAuthnAvailable(null)).toBe(false);
    expect(isWebAuthnAvailable({ navigator: {} } as unknown as Window)).toBe(false);
    expect(
      isWebAuthnAvailable({
        PublicKeyCredential: class {},
        navigator: { credentials: { get: () => undefined } },
      } as unknown as Window),
    ).toBe(true);
  });
});
