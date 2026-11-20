using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>What the budget file holds: the month, its spend and the cap. Never a key, never a model payload.</summary>
public sealed record PersistedBudget(
    [property: JsonPropertyName("month")] string Month,
    // A missing spend would read as zero and be overwritten as a real one.
    [property: JsonPropertyName("spentUsd"), JsonRequired] decimal SpentUsd,
    [property: JsonPropertyName("budgetUsd")] decimal BudgetUsd);

/// <summary>
/// The monthly budget in one local JSON file (<c>Feedback:BudgetStorePath</c>; REQUIREMENTS.md FR-74; ARCHITECTURE.md D-61), for one
/// replica. A write goes to a temp file beside it and then replaces it, so a crash leaves the old file or the new, never half
/// of one. A missing file is a safe zero-spend start. A corrupt or unreadable one is too, with a logged warning, and is
/// renamed to <c>&lt;name&gt;.corrupt-&lt;utc&gt;</c> before the next write so the evidence is not overwritten. Corrupt
/// includes JSON that parses but has no <c>spentUsd</c>, a negative one, or a <c>month</c> that is not <c>yyyy-MM</c>. It shares
/// nothing with the layouts store, and reaches the disk only through <see cref="IFeedbackBudgetFiles"/>.
/// </summary>
public sealed partial class FeedbackBudgetStore(string path, IFeedbackBudgetFiles files, TimeProvider time, ILogger logger)
{
    /// <summary>The suffix of the temp file a write goes through.</summary>
    public const string TempSuffix = ".tmp";

    /// <summary>The infix of the name a corrupt file is moved to; a UTC stamp follows.</summary>
    public const string CorruptInfix = ".corrupt-";

    /// <summary>The one form a saved month may take, the form <see cref="FeedbackBudget"/> writes.</summary>
    public const string MonthFormat = "yyyy-MM";

    private bool _moveAside;

    public string Path { get; } = path;

    /// <summary>The saved budget, or null when the file is missing, empty, corrupt or holds nonsense.</summary>
    public PersistedBudget? Load()
    {
        try
        {
            var text = files.Read(Path);
            if (text is null)
            {
                return null;
            }

            var saved = JsonSerializer.Deserialize<PersistedBudget>(text);
            if (saved is null || !IsMonth(saved.Month) || saved.SpentUsd < 0m)
            {
                _moveAside = true;
                LogUnusable(Path);
                return null;
            }

            return saved;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException)
        {
            _moveAside = true;
            LogUnreadable(Path, ex.GetType().Name);
            return null;
        }
    }

    /// <summary>Writes the budget atomically. A failure is logged and swallowed: a full disk must not fail a feedback request.</summary>
    public void Save(PersistedBudget budget)
    {
        ArgumentNullException.ThrowIfNull(budget);
        MoveCorruptAside();
        var temp = Path + TempSuffix;
        try
        {
            files.Write(temp, JsonSerializer.Serialize(budget));
            files.Move(temp, Path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            LogUnsaved(Path, ex.GetType().Name);
        }
    }

    // A month in any other form would be rolled to zero as if it were an earlier one, and the file overwritten.
    private static bool IsMonth(string? month) =>
        DateTime.TryParseExact(month, MonthFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    private void MoveCorruptAside()
    {
        if (!_moveAside)
        {
            return;
        }

        _moveAside = false;
        var aside = Path + CorruptInfix + time.GetUtcNow().ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
        try
        {
            files.Move(Path, aside, overwrite: true);
            LogMovedAside(Path, aside);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            LogNotMovedAside(Path, ex.GetType().Name);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "The feedback budget file {Path} holds no usable budget; starting this month at zero spend.")]
    private partial void LogUnusable(string path);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The feedback budget file {Path} could not be read ({Cause}); starting this month at zero spend.")]
    private partial void LogUnreadable(string path, string cause);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The feedback budget could not be saved to {Path} ({Cause}); the count stays in memory.")]
    private partial void LogUnsaved(string path, string cause);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The unusable feedback budget file {Path} was moved aside to {Aside}.")]
    private partial void LogMovedAside(string path, string aside);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The unusable feedback budget file {Path} could not be moved aside ({Cause}).")]
    private partial void LogNotMovedAside(string path, string cause);
}
