using System.Globalization;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>The month's spend against the cap. <see cref="Exhausted"/> at or over it.</summary>
public sealed record BudgetState(decimal SpentUsd, decimal BudgetUsd, string Month, long ResetsAtMs)
{
    public bool Exhausted => SpentUsd >= BudgetUsd;
}

/// <summary>
/// The monthly spend on Claude calls, counted in memory from each reply's <c>usage</c> (REQUIREMENTS.md FR-74, NFR-9). A restart
/// resets it, as the in-memory layouts of D-18 are reset. The check comes before a call and the count after it, so
/// calls already in flight when the cap is reached can each take the spend past it once.
/// </summary>
public sealed class FeedbackBudget(TimeProvider time, IOptions<FeedbackOptions> options)
{
    private readonly Lock _gate = new();
    private string _month = string.Empty;
    private decimal _spent;

    public BudgetState Current()
    {
        lock (_gate)
        {
            var (month, resetsAt) = Roll();
            return new BudgetState(_spent, options.Value.MonthlyBudgetUsd, month, resetsAt);
        }
    }

    public void Record(IEnumerable<TokenUsage> usage)
    {
        ArgumentNullException.ThrowIfNull(usage);
        var cost = usage.Sum(ModelPrices.CostUsd);
        lock (_gate)
        {
            Roll();
            _spent += cost;
        }
    }

    private (string Month, long ResetsAtMs) Roll()
    {
        var now = time.GetUtcNow();
        var month = now.ToString("yyyy-MM", CultureInfo.InvariantCulture);
        if (month != _month)
        {
            _month = month;
            _spent = 0m;
        }

        var start = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);
        return (month, start.AddMonths(1).ToUnixTimeMilliseconds());
    }
}
