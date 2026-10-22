namespace UniOver.Modules.Training.Domain.Foods;

public static class FoodSources
{
    public const string Own = "own";
    public const string Off = "off";
    public const string Taco = "taco";
}

public sealed class Food
{
    public Guid Id { get; set; }
    public string Source { get; set; } = FoodSources.Own;
    public string? SourceRef { get; set; }
    public Guid? OwnerUserId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Brand { get; set; }
    public string? Barcode { get; set; }
    public decimal KcalPer100g { get; set; }
    public decimal ProteinPer100g { get; set; }
    public decimal CarbsPer100g { get; set; }
    public decimal FatPer100g { get; set; }
    public decimal? DefaultPortionGrams { get; set; }
    public string? Attribution { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset ClientUpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    public bool IsDeleted => DeletedAt is not null;
}

public sealed class MealEntry
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid? FoodId { get; set; }
    public DateOnly EatenOn { get; set; }
    public DateTimeOffset? EatenAt { get; set; }
    public string MealType { get; set; } = "other";
    public string FoodName { get; set; } = string.Empty;
    public decimal Grams { get; set; }
    public decimal Kcal { get; set; }
    public decimal Protein { get; set; }
    public decimal Carbs { get; set; }
    public decimal Fat { get; set; }
    public string? Note { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset ClientUpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    public bool IsDeleted => DeletedAt is not null;
}

public static class FoodRules
{
    public const int NameMax = 160;
    public const int BrandMax = 120;
    public const int NoteMax = 300;

    public static bool IsValidMacro(decimal value) => value >= 0 && decimal.Round(value, 2) == value && value <= 99999.99m;
    public static bool IsValidPortion(decimal? grams) => grams is null || (grams > 0 && grams <= 10000 && decimal.Round(grams.Value, 2) == grams);
}

public static class MealTypes
{
    public const string Breakfast = "breakfast";
    public const string Lunch = "lunch";
    public const string Snack = "snack";
    public const string Dinner = "dinner";
    public const string Other = "other";
    public static IReadOnlyList<string> All { get; } = [Breakfast, Lunch, Snack, Dinner, Other];
    public static bool IsValid(string? value) => All.Contains(value, StringComparer.Ordinal);
}
