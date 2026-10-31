using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Training.Domain.Body;

namespace UniOver.Modules.Training.Persistence.Configurations;

internal sealed class BodyEntryConfiguration : IEntityTypeConfiguration<BodyEntry>
{
    private static readonly string EarliestDate = BodyLimits.EarliestDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static string Num(decimal value) => value.ToString(CultureInfo.InvariantCulture);

    public void Configure(EntityTypeBuilder<BodyEntry> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("body_entries", t =>
        {
            // Cada valor é opcional, mas, se vier, fica na faixa. O "IS NULL OR" explícito importa: um check que dá NULL
            // (valor nulo comparado com a faixa) é aceito pelo Postgres.
            t.HasCheckConstraint("ck_body_entries_weight", $"weight_kg IS NULL OR weight_kg BETWEEN {Num(BodyLimits.WeightMinKg)} AND {Num(BodyLimits.WeightMaxKg)}");
            t.HasCheckConstraint("ck_body_entries_body_fat", $"body_fat_pct IS NULL OR body_fat_pct BETWEEN {Num(BodyLimits.BodyFatMinPct)} AND {Num(BodyLimits.BodyFatMaxPct)}");
            t.HasCheckConstraint("ck_body_entries_waist", Circumference("waist_cm"));
            t.HasCheckConstraint("ck_body_entries_neck", Circumference("neck_cm"));
            t.HasCheckConstraint("ck_body_entries_hip", Circumference("hip_cm"));
            t.HasCheckConstraint("ck_body_entries_arm", Circumference("arm_cm"));
            t.HasCheckConstraint("ck_body_entries_thigh", Circumference("thigh_cm"));
            t.HasCheckConstraint("ck_body_entries_chest", Circumference("chest_cm"));
            t.HasCheckConstraint("ck_body_entries_abdomen", Circumference("abdomen_cm"));
            t.HasCheckConstraint("ck_body_entries_forearm", Circumference("forearm_cm"));
            t.HasCheckConstraint("ck_body_entries_calf", Circumference("calf_cm"));
            t.HasCheckConstraint("ck_body_entries_arm_right", Circumference("arm_right_cm"));
            t.HasCheckConstraint("ck_body_entries_arm_left", Circumference("arm_left_cm"));
            t.HasCheckConstraint("ck_body_entries_forearm_right", Circumference("forearm_right_cm"));
            t.HasCheckConstraint("ck_body_entries_forearm_left", Circumference("forearm_left_cm"));
            t.HasCheckConstraint("ck_body_entries_thigh_right", Circumference("thigh_right_cm"));
            t.HasCheckConstraint("ck_body_entries_thigh_left", Circumference("thigh_left_cm"));
            t.HasCheckConstraint("ck_body_entries_calf_right", Circumference("calf_right_cm"));
            t.HasCheckConstraint("ck_body_entries_calf_left", Circumference("calf_left_cm"));
            t.HasCheckConstraint("ck_body_entries_chest_skinfold", Skinfold("chest_skinfold_mm"));
            t.HasCheckConstraint("ck_body_entries_abdomen_skinfold", Skinfold("abdomen_skinfold_mm"));
            t.HasCheckConstraint("ck_body_entries_thigh_skinfold", Skinfold("thigh_skinfold_mm"));
            t.HasCheckConstraint("ck_body_entries_fat_method", "fat_method IS NULL OR fat_method IN ('navy', 'manual', 'bioimpedance')");

            // O método só existe junto do percentual (e vice-versa): "gordura sem dizer de onde veio" não se grava.
            t.HasCheckConstraint("ck_body_entries_fat_pair", "(body_fat_pct IS NULL) = (fat_method IS NULL)");
            t.HasCheckConstraint("ck_body_entries_note", $"note IS NULL OR char_length(note) <= {BodyLimits.NoteMax}");
            t.HasCheckConstraint("ck_body_entries_measured_on", $"measured_on >= DATE '{EarliestDate}'");

            // A medição viva precisa de pelo menos um valor; só a lápide pode estar vazia (os valores dela são esvaziados).
            t.HasCheckConstraint(
                "ck_body_entries_not_empty",
                "(weight_kg IS NOT NULL OR body_fat_pct IS NOT NULL OR waist_cm IS NOT NULL OR neck_cm IS NOT NULL " +
                "OR hip_cm IS NOT NULL OR arm_cm IS NOT NULL OR thigh_cm IS NOT NULL OR chest_cm IS NOT NULL OR abdomen_cm IS NOT NULL " +
                "OR forearm_cm IS NOT NULL OR calf_cm IS NOT NULL OR arm_right_cm IS NOT NULL OR arm_left_cm IS NOT NULL " +
                "OR forearm_right_cm IS NOT NULL OR forearm_left_cm IS NOT NULL OR thigh_right_cm IS NOT NULL OR thigh_left_cm IS NOT NULL " +
                "OR calf_right_cm IS NOT NULL OR calf_left_cm IS NOT NULL OR chest_skinfold_mm IS NOT NULL OR abdomen_skinfold_mm IS NOT NULL " +
                "OR thigh_skinfold_mm IS NOT NULL) OR deleted_at IS NOT NULL");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();

        // O usuário é de outro módulo: só o id, sem chave estrangeira.
        e.Property(x => x.UserId).IsRequired();
        e.Property(x => x.WeightKg).HasPrecision(5, 2);
        e.Property(x => x.BodyFatPct).HasPrecision(4, 1);
        e.Property(x => x.FatMethod).HasMaxLength(12);
        e.Property(x => x.WaistCm).HasPrecision(4, 1);
        e.Property(x => x.NeckCm).HasPrecision(4, 1);
        e.Property(x => x.HipCm).HasPrecision(4, 1);
        e.Property(x => x.ArmCm).HasPrecision(4, 1);
        e.Property(x => x.ThighCm).HasPrecision(4, 1);
        e.Property(x => x.ChestCm).HasPrecision(4, 1);
        e.Property(x => x.AbdomenCm).HasPrecision(4, 1);
        e.Property(x => x.ForearmCm).HasPrecision(4, 1);
        e.Property(x => x.CalfCm).HasPrecision(4, 1);
        e.Property(x => x.ArmRightCm).HasPrecision(4, 1);
        e.Property(x => x.ArmLeftCm).HasPrecision(4, 1);
        e.Property(x => x.ForearmRightCm).HasPrecision(4, 1);
        e.Property(x => x.ForearmLeftCm).HasPrecision(4, 1);
        e.Property(x => x.ThighRightCm).HasPrecision(4, 1);
        e.Property(x => x.ThighLeftCm).HasPrecision(4, 1);
        e.Property(x => x.CalfRightCm).HasPrecision(4, 1);
        e.Property(x => x.CalfLeftCm).HasPrecision(4, 1);
        e.Property(x => x.ChestSkinfoldMm).HasPrecision(4, 1);
        e.Property(x => x.AbdomenSkinfoldMm).HasPrecision(4, 1);
        e.Property(x => x.ThighSkinfoldMm).HasPrecision(4, 1);
        e.Property(x => x.Note).HasMaxLength(BodyLimits.NoteMax);

        // A linha do tempo do dono (a tela lê por data) e a ordem do cursor da leitura incremental, sempre dentro de um usuário.
        e.HasIndex(x => new { x.UserId, x.MeasuredOn });
        e.HasIndex(x => new { x.UserId, x.UpdatedAt, x.Id });

        // Duas escritas ao mesmo tempo na mesma medição: a que chega com o valor antigo é recusada e relê (último a escrever).
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();

        e.Ignore(x => x.IsDeleted);
        e.Ignore(x => x.HasAnyValue);
    }

    private static string Circumference(string column) =>
        $"{column} IS NULL OR {column} BETWEEN {Num(BodyLimits.CircumferenceMinCm)} AND {Num(BodyLimits.CircumferenceMaxCm)}";

    private static string Skinfold(string column) =>
        $"{column} IS NULL OR {column} BETWEEN {Num(BodyLimits.SkinfoldMinMm)} AND {Num(BodyLimits.SkinfoldMaxMm)}";
}

internal sealed class BodyProfileConfiguration : IEntityTypeConfiguration<BodyProfile>
{
    private static readonly string EarliestDate = BodyLimits.EarliestDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static string Num(decimal value) => value.ToString(CultureInfo.InvariantCulture);

    public void Configure(EntityTypeBuilder<BodyProfile> e)
    {
        ArgumentNullException.ThrowIfNull(e);

        e.ToTable("body_profile", t =>
        {
            t.HasCheckConstraint("ck_body_profile_height", $"height_cm BETWEEN {Num(BodyLimits.HeightMinCm)} AND {Num(BodyLimits.HeightMaxCm)}");
            t.HasCheckConstraint("ck_body_profile_birth_date", $"birth_date >= DATE '{EarliestDate}'");
            t.HasCheckConstraint("ck_body_profile_sex", "sex IN ('male', 'female')");
            t.HasCheckConstraint("ck_body_profile_activity", $"activity_factor BETWEEN {Num(BodyLimits.ActivityFactorMin)} AND {Num(BodyLimits.ActivityFactorMax)}");
        });

        // A chave natural é o usuário (um perfil por pessoa): 50 pedidos simultâneos terminam numa linha só porque a chave
        // primária recusa a segunda inserção. O usuário é de outro módulo: só o id, sem chave estrangeira.
        e.HasKey(x => x.UserId);
        e.Property(x => x.UserId).ValueGeneratedNever();
        e.Property(x => x.HeightCm).HasPrecision(4, 1);
        e.Property(x => x.Sex).HasMaxLength(6).IsRequired();
        e.Property(x => x.ActivityFactor).HasPrecision(3, 2);

        // Duas escritas ao mesmo tempo no mesmo perfil: a que chega com o valor antigo é recusada e relê (último a escrever).
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();
    }
}
