using System.Security.Cryptography;
using System.Text;
using UniOver.Modules.Training.Domain.Foods;

namespace UniOver.Modules.Training.Features.Foods;

internal sealed record FoodResponse(Guid Id, string Source, string Name, string? Brand, string? Barcode, decimal KcalPer100g,
    decimal ProteinPer100g, decimal CarbsPer100g, decimal FatPer100g, decimal? DefaultPortionGrams, string? Attribution,
    DateTimeOffset UpdatedAt, DateTimeOffset ClientUpdatedAt, bool Deleted)
{
    public static FoodResponse From(Food f) => new(f.Id, f.Source, f.Name, f.Brand, f.Barcode, f.KcalPer100g,
        f.ProteinPer100g, f.CarbsPer100g, f.FatPer100g, f.DefaultPortionGrams, f.Attribution, f.UpdatedAt, f.ClientUpdatedAt, f.IsDeleted);
}

internal sealed record MealResponse(Guid Id, Guid? FoodId, DateOnly EatenOn, DateTimeOffset? EatenAt, string MealType,
    string Name, decimal QuantityG, decimal Kcal, decimal ProteinG, decimal CarbG, decimal FatG, string? Note,
    DateTimeOffset UpdatedAt, DateTimeOffset ClientUpdatedAt, bool Deleted)
{
    public static MealResponse From(MealEntry e) => new(e.Id, e.FoodId, e.EatenOn, e.EatenAt, e.MealType, e.FoodName,
        e.Grams, e.Kcal, e.Protein, e.Carbs, e.Fat, e.Note, e.UpdatedAt, e.ClientUpdatedAt, e.IsDeleted);
}

internal static class ExternalFoodIds
{
    private static readonly Guid Namespace = new("68e57f47-bf64-5d2e-8ea8-75942fce3298");
    public static Guid Create(string source, string reference)
    {
        var ns = Namespace.ToByteArray();
        Swap(ns);
        var name = Encoding.UTF8.GetBytes($"{source}:{reference}");
        var bytes = new byte[ns.Length + name.Length];
        Buffer.BlockCopy(ns, 0, bytes, 0, ns.Length);
        Buffer.BlockCopy(name, 0, bytes, ns.Length, name.Length);
#pragma warning disable CA5350 // UUID v5 is defined by RFC 4122 to use SHA-1; this is an identifier, not a security digest.
        var hash = SHA1.HashData(bytes);
#pragma warning restore CA5350
        var id = hash[..16];
        id[6] = (byte)((id[6] & 0x0F) | 0x50);
        id[8] = (byte)((id[8] & 0x3F) | 0x80);
        Swap(id);
        return new Guid(id);
    }

    private static void Swap(byte[] b)
    {
        (b[0], b[3]) = (b[3], b[0]); (b[1], b[2]) = (b[2], b[1]);
        (b[4], b[5]) = (b[5], b[4]); (b[6], b[7]) = (b[7], b[6]);
    }
}
