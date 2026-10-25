using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Persistence.Configurations;

internal sealed class ProgressPhotoConfiguration : IEntityTypeConfiguration<ProgressPhoto>
{
    public void Configure(EntityTypeBuilder<ProgressPhoto> e)
    {
        ArgumentNullException.ThrowIfNull(e);
        e.ToTable("progress_photos", t =>
        {
            t.HasCheckConstraint("ck_progress_photos_dimensions", "width BETWEEN 1 AND 1280 AND height BETWEEN 1 AND 1280 AND (width::bigint * height) <= 1638400");
            t.HasCheckConstraint("ck_progress_photos_bytes", "byte_length BETWEEN 4 AND 5242880");
            t.HasCheckConstraint("ck_progress_photos_sha256", "sha256 ~ '^[0-9a-f]{64}$'");
            t.HasCheckConstraint("ck_progress_photos_state", "state IN ('pending', 'ready', 'deleted')");
            t.HasCheckConstraint("ck_progress_photos_deleted_at", "(state = 'deleted') = (deleted_at IS NOT NULL)");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();
        e.Property(x => x.UserId).IsRequired();
        e.Property(x => x.ObjectKey).HasMaxLength(128).IsRequired();
        e.Property(x => x.Sha256).HasMaxLength(64).IsRequired();
        e.Property(x => x.State).HasMaxLength(8).IsRequired();
        e.HasIndex(x => new { x.UserId, x.TakenOn, x.CreatedAt, x.Id }).HasFilter("state = 'ready'");
        e.HasIndex(x => x.ObjectKey).IsUnique();
    }
}
