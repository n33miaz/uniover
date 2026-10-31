using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Persistence.Configurations;

internal sealed class CalendarEntryConfiguration : IEntityTypeConfiguration<CalendarEntry>
{
    public void Configure(EntityTypeBuilder<CalendarEntry> e)
    {
        e.ToTable("calendar_entries", t =>
        {
            t.HasCheckConstraint("ck_calendar_entries_note", "note IS NULL OR char_length(note) BETWEEN 1 AND 280");
            t.HasCheckConstraint("ck_calendar_entries_live", "deleted_at IS NOT NULL OR absent OR note IS NOT NULL");
        });
        e.HasKey(x => x.Id);
        e.Property(x => x.Id).ValueGeneratedNever();
        e.Property(x => x.Note).HasMaxLength(280);
        e.HasIndex(x => new { x.UserId, x.Day }).IsUnique();
        e.HasIndex(x => new { x.UserId, x.UpdatedAt, x.Id });
        e.Property(x => x.ClientUpdatedAt).IsConcurrencyToken();
        e.Ignore(x => x.IsDeleted);
    }
}
