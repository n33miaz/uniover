using System.Buffers.Text;
using System.Formats.Cbor;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace UniOver.IntegrationTests.Identity.Passkeys;

/// <summary>
/// Autenticador de teste: gera uma chave EC P-256 em memória (nenhuma chave em arquivo) e monta, no formato que o
/// navegador envia, a atestação <c>none</c> do cadastro e a asserção da confirmação. O contador é controlado pelo
/// teste para provar a regra de "só cresce".
/// </summary>
internal sealed class VirtualAuthenticator : IDisposable
{
    private const byte FlagUserPresent = 0x01;
    private const byte FlagUserVerified = 0x04;
    private const byte FlagAttestedData = 0x40;

    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private byte[] _userHandle = [];

    public VirtualAuthenticator(string rpId = "localhost", string origin = "https://localhost", bool countsSignatures = true)
    {
        RpId = rpId;
        Origin = origin;
        CountsSignatures = countsSignatures;
        CredentialId = RandomNumberGenerator.GetBytes(32);
    }

    public string RpId { get; }

    public string Origin { get; set; }

    public bool CountsSignatures { get; }

    public byte[] CredentialId { get; }

    /// <summary>Contador gravado no próximo uso; o teste pode forçar um valor.</summary>
    public uint SignCount { get; set; }

    public static string B64(byte[] data) => Base64Url.EncodeToString(data);

    public static byte[] Unb64(string text) => Base64Url.DecodeFromChars(text);

    /// <summary>Resposta de cadastro a partir das opções (<c>options</c> do servidor) devolvidas ao cliente.</summary>
    public object CreateAttestation(JsonElement options, bool userVerified = true)
    {
        var challenge = options.GetProperty("challenge").GetString()!;
        _userHandle = Unb64(options.GetProperty("user").GetProperty("id").GetString()!);

        var authData = AuthenticatorData(
            (byte)(FlagUserPresent | FlagAttestedData | (userVerified ? FlagUserVerified : 0)),
            attestedCredential: true);

        var attestation = new CborWriter(CborConformanceMode.Ctap2Canonical);
        attestation.WriteStartMap(3);
        attestation.WriteTextString("fmt");
        attestation.WriteTextString("none");
        attestation.WriteTextString("attStmt");
        attestation.WriteStartMap(0);
        attestation.WriteEndMap();
        attestation.WriteTextString("authData");
        attestation.WriteByteString(authData);
        attestation.WriteEndMap();

        return new
        {
            id = B64(CredentialId),
            rawId = B64(CredentialId),
            type = "public-key",
            response = new
            {
                attestationObject = B64(attestation.Encode()),
                clientDataJSON = B64(ClientData("webauthn.create", challenge)),
                transports = new[] { "internal" },
            },
            clientExtensionResults = new { },
        };
    }

    /// <summary>Resposta de confirmação (asserção) a partir das opções recebidas.</summary>
    public object CreateAssertion(JsonElement options, bool userVerified = true)
    {
        var challenge = options.GetProperty("challenge").GetString()!;
        var authData = AuthenticatorData(
            (byte)(FlagUserPresent | (userVerified ? FlagUserVerified : 0)), attestedCredential: false);
        var clientData = ClientData("webauthn.get", challenge);

        var signed = authData.Concat(SHA256.HashData(clientData)).ToArray();
        // O WebAuthn usa a assinatura ECDSA em DER; o padrão do .NET (P1363) não é aceito.
        var signature = _key.SignData(signed, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);

        return new
        {
            id = B64(CredentialId),
            rawId = B64(CredentialId),
            type = "public-key",
            response = new
            {
                authenticatorData = B64(authData),
                clientDataJSON = B64(clientData),
                signature = B64(signature),
                userHandle = _userHandle.Length == 0 ? null : B64(_userHandle),
            },
            clientExtensionResults = new { },
        };
    }

    private byte[] ClientData(string type, string challenge) =>
        JsonSerializer.SerializeToUtf8Bytes(new { type, challenge, origin = Origin, crossOrigin = false });

    private byte[] AuthenticatorData(byte flags, bool attestedCredential)
    {
        using var stream = new MemoryStream();
        stream.Write(SHA256.HashData(Encoding.UTF8.GetBytes(RpId)));
        stream.WriteByte(flags);

        var counter = CountsSignatures ? SignCount : 0u;
        stream.Write([(byte)(counter >> 24), (byte)(counter >> 16), (byte)(counter >> 8), (byte)counter]);

        if (attestedCredential)
        {
            stream.Write(new byte[16]); // aaguid zerado: autenticador anônimo
            stream.Write([(byte)(CredentialId.Length >> 8), (byte)CredentialId.Length]);
            stream.Write(CredentialId);
            stream.Write(CoseKey());
        }

        return stream.ToArray();
    }

    private byte[] CoseKey()
    {
        var parameters = _key.ExportParameters(includePrivateParameters: false);
        var cose = new CborWriter(CborConformanceMode.Ctap2Canonical);
        cose.WriteStartMap(5);
        cose.WriteInt32(1);
        cose.WriteInt32(2); // kty: EC2
        cose.WriteInt32(3);
        cose.WriteInt32(-7); // alg: ES256
        cose.WriteInt32(-1);
        cose.WriteInt32(1); // crv: P-256
        cose.WriteInt32(-2);
        cose.WriteByteString(parameters.Q.X!);
        cose.WriteInt32(-3);
        cose.WriteByteString(parameters.Q.Y!);
        cose.WriteEndMap();
        return cose.Encode();
    }

    public void Dispose() => _key.Dispose();
}
