/**
 * Conversões entre o JSON do servidor (binários em base64url) e o que `navigator.credentials` aceita e devolve.
 * As opções são montadas campo a campo, a partir de uma lista fixa: repassar o JSON do servidor como está
 * levaria campos nulos ou desconhecidos ao navegador (um `rpId` nulo vira a string "null" e dá SecurityError).
 */

export function base64urlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bin(value: unknown): ArrayBuffer | undefined {
  const text = str(value);
  return text === undefined ? undefined : base64urlToBuffer(text);
}

function descriptors(value: unknown): PublicKeyCredentialDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const entry = asObject(item);
    const id = bin(entry?.['id']);
    if (!entry || id === undefined) return [];
    const transports = Array.isArray(entry['transports'])
      ? (entry['transports'].filter((t) => typeof t === 'string') as AuthenticatorTransport[])
      : undefined;
    return [
      {
        type: 'public-key' as const,
        id,
        ...(transports && transports.length > 0 ? { transports } : {}),
      },
    ];
  });
}

/** Opções da confirmação (asserção) → argumento de `navigator.credentials.get`. */
export function toRequestOptions(json: unknown): PublicKeyCredentialRequestOptions {
  const source = asObject(json);
  const challenge = bin(source?.['challenge']);
  if (!source || challenge === undefined) throw new Error('Opções de confirmação inválidas.');
  const timeout = num(source['timeout']);
  const rpId = str(source['rpId']);
  const userVerification = str(source['userVerification']) as
    UserVerificationRequirement | undefined;
  const allowCredentials = descriptors(source['allowCredentials']);
  return {
    challenge,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(rpId !== undefined ? { rpId } : {}),
    ...(allowCredentials.length > 0 ? { allowCredentials } : {}),
    userVerification: userVerification ?? 'required',
  };
}

/** Opções do cadastro (atestação) → argumento de `navigator.credentials.create`. */
export function toCreationOptions(json: unknown): PublicKeyCredentialCreationOptions {
  const source = asObject(json);
  const challenge = bin(source?.['challenge']);
  const rp = asObject(source?.['rp']);
  const user = asObject(source?.['user']);
  const userId = bin(user?.['id']);
  if (!source || challenge === undefined || !rp || !user || userId === undefined) {
    throw new Error('Opções de cadastro inválidas.');
  }

  const rpId = str(rp['id']);
  const params = Array.isArray(source['pubKeyCredParams'])
    ? source['pubKeyCredParams'].flatMap((item: unknown) => {
        const alg = num(asObject(item)?.['alg']);
        return alg === undefined ? [] : [{ type: 'public-key' as const, alg }];
      })
    : [];
  const selection = asObject(source['authenticatorSelection']);
  const attachment = str(selection?.['authenticatorAttachment']) as
    AuthenticatorAttachment | undefined;
  const residentKey = str(selection?.['residentKey']) as ResidentKeyRequirement | undefined;
  const verification = str(selection?.['userVerification']) as
    UserVerificationRequirement | undefined;
  const attestation = str(source['attestation']) as AttestationConveyancePreference | undefined;
  const timeout = num(source['timeout']);
  const exclude = descriptors(source['excludeCredentials']);

  return {
    challenge,
    rp: { name: str(rp['name']) ?? 'UniOver', ...(rpId !== undefined ? { id: rpId } : {}) },
    user: {
      id: userId,
      name: str(user['name']) ?? '',
      displayName: str(user['displayName']) ?? str(user['name']) ?? '',
    },
    pubKeyCredParams: params.length > 0 ? params : [{ type: 'public-key', alg: -7 }],
    ...(timeout !== undefined ? { timeout } : {}),
    ...(exclude.length > 0 ? { excludeCredentials: exclude } : {}),
    authenticatorSelection: {
      ...(attachment !== undefined ? { authenticatorAttachment: attachment } : {}),
      ...(residentKey !== undefined ? { residentKey } : {}),
      userVerification: verification ?? 'required',
    },
    attestation: attestation ?? 'none',
  };
}

/** Resposta da confirmação → corpo de `step-up/complete` (tudo em base64url sem preenchimento). */
export function assertionToJson(credential: PublicKeyCredential): Json {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bufferToBase64url(response.authenticatorData),
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
}

/** Resposta do cadastro → corpo de `passkeys/registration/complete`. */
export function attestationToJson(credential: PublicKeyCredential): Json {
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = response.getTransports?.() ?? [];
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: bufferToBase64url(response.attestationObject),
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      ...(transports.length > 0 ? { transports } : {}),
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
}

/** O aparelho tem WebAuthn? (Ausente em navegadores antigos e em contextos sem HTTPS.) */
export function isWebAuthnAvailable(win: Window | null | undefined): boolean {
  return !!win && 'PublicKeyCredential' in win && !!win.navigator?.credentials?.get;
}
