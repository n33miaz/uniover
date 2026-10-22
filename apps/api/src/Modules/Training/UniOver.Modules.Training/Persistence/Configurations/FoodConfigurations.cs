using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Training.Domain.Foods;

namespace UniOver.Modules.Training.Persistence.Configurations;

internal sealed class FoodConfiguration : IEntityTypeConfiguration<Food>
{
    public void Configure(EntityTypeBuilder<Food> e)
    {
        e.ToTable("foods", t =>
        {
            t.HasCheckConstraint("ck_foods_source", "source IN ('own', 'off', 'taco')");
            t.HasCheckConstraint("ck_foods_owner_source", "(source = 'own' AND owner_user_id IS NOT NULL) OR (source <> 'own' AND owner_user_id IS NULL)");
            t.HasCheckConstraint("ck_foods_source_ref", "(source = 'own' AND source_ref IS NULL) OR (source <> 'own' AND source_ref IS NOT NULL)");
            t.HasCheckConstraint("ck_foods_name", "(char_length(btrim(name)) BETWEEN 1 AND 160) OR deleted_at IS NOT NULL");
            t.HasCheckConstraint("ck_foods_kcal", "kcal_100g BETWEEN 0 AND 99999.99");
            t.HasCheckConstraint("ck_foods_protein", "protein_100g BETWEEN 0 AND 99999.99");
            t.HasCheckConstraint("ck_foods_carbs", "carb_100g BETWEEN 0 AND 99999.99");
            t.HasCheckConstraint("ck_foods_fat", "fat_100g BETWEEN 0 AND 99999.99");
            t.HasCheckConstraint("ck_foods_portion", "default_portion_g IS NULL OR default_portion_g BETWEEN 0.01 AND 10000");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();
        e.Property(x => x.Source).HasMaxLength(8).IsRequired();
        e.Property(x => x.SourceRef).HasMaxLength(160);
        e.Property(x => x.Name).HasMaxLength(FoodRules.NameMax).IsRequired();
        e.Property(x => x.Brand).HasMaxLength(FoodRules.BrandMax);
        e.Property(x => x.Barcode).HasMaxLength(14);
        e.Property(x => x.KcalPer100g).HasPrecision(7, 2);
        e.Property(x => x.ProteinPer100g).HasPrecision(7, 2);
        e.Property(x => x.CarbsPer100g).HasPrecision(7, 2);
        e.Property(x => x.FatPer100g).HasPrecision(7, 2);
        e.Property(x => x.DefaultPortionGrams).HasPrecision(7, 2);
        e.Property(x => x.KcalPer100g).HasColumnName("kcal_100g");
        e.Property(x => x.ProteinPer100g).HasColumnName("protein_100g");
        e.Property(x => x.CarbsPer100g).HasColumnName("carb_100g");
        e.Property(x => x.FatPer100g).HasColumnName("fat_100g");
        e.Property(x => x.DefaultPortionGrams).HasColumnName("default_portion_g");
        e.Property(x => x.Attribution).HasMaxLength(240);
        e.HasIndex(x => new { x.Source, x.SourceRef }).IsUnique().HasFilter("source_ref IS NOT NULL");
        e.HasIndex(x => new { x.OwnerUserId, x.UpdatedAt, x.Id });
        e.HasIndex(x => x.Barcode).HasFilter("barcode IS NOT NULL AND deleted_at IS NULL");
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();
        e.Ignore(x => x.IsDeleted);
    }
}

internal sealed class MealEntryConfiguration : IEntityTypeConfiguration<MealEntry>
{
    public void Configure(EntityTypeBuilder<MealEntry> e)
    {
        e.ToTable("meal_entries", t =>
        {
            t.HasCheckConstraint("ck_meal_entries_type", "meal_type IN ('breakfast', 'lunch', 'snack', 'dinner', 'other')");
            t.HasCheckConstraint("ck_meal_entries_grams", "(quantity_g > 0 AND quantity_g <= 10000) OR deleted_at IS NOT NULL");
            t.HasCheckConstraint("ck_meal_entries_kcal", "kcal >= 0 AND kcal <= 999999.99");
            t.HasCheckConstraint("ck_meal_entries_protein", "protein_g >= 0 AND protein_g <= 999999.99");
            t.HasCheckConstraint("ck_meal_entries_carbs", "carb_g >= 0 AND carb_g <= 999999.99");
            t.HasCheckConstraint("ck_meal_entries_fat", "fat_g >= 0 AND fat_g <= 999999.99");
            t.HasCheckConstraint("ck_meal_entries_note", "note IS NULL OR char_length(note) <= 300");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();
        e.Property(x => x.UserId).IsRequired();
        e.Property(x => x.MealType).HasMaxLength(12).IsRequired();
        e.Property(x => x.FoodName).HasMaxLength(FoodRules.NameMax).IsRequired();
        e.Property(x => x.Grams).HasPrecision(7, 2).HasColumnName("quantity_g");
        e.Property(x => x.Kcal).HasPrecision(8, 2);
        e.Property(x => x.FoodName).HasColumnName("name");
        e.Property(x => x.Protein).HasPrecision(8, 2).HasColumnName("protein_g");
        e.Property(x => x.Carbs).HasPrecision(8, 2).HasColumnName("carb_g");
        e.Property(x => x.Fat).HasPrecision(8, 2).HasColumnName("fat_g");
        e.Property(x => x.Note).HasMaxLength(FoodRules.NoteMax);
        e.HasOne<Food>().WithMany().HasForeignKey(x => x.FoodId).OnDelete(DeleteBehavior.Restrict);
        e.HasIndex(x => new { x.UserId, x.EatenOn });
        e.HasIndex(x => new { x.UserId, x.UpdatedAt, x.Id });
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();
        e.Ignore(x => x.IsDeleted);
    }
}
