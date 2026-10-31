using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Security;

internal static class DeviceKeyRegistration
{
    /// <summary>
    /// Grava a chave do aparelho na família que acabou de nascer (login, convite aceito, entrada por QR), se o cliente
    /// mandou uma chave P-256 válida. Entra no mesmo <c>SaveChanges</c> do primeiro token. Sem chave (ou inválida) a
    /// família nasce sem recuperação, e qualquer reuso do refresh dela revoga, como sempre.
    /// </summary>
    public static void Add(IdentityDbContext db, Guid familyId, Guid userId, ClientInfo client, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(client);

        if (DeviceProof.NormalizeKey(client.DeviceKey) is { } key)
        {
            db.RefreshDeviceKeys.Add(RefreshDeviceKey.Create(familyId, userId, key, now));
        }
    }
}
