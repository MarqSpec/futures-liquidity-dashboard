using System.Globalization;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;


/// <summary>The month's spend against the cap. <see cref="Exhausted"/> at or over it.</summary>
public sealed record BudgetState(decimal SpentUsd, decimal BudgetUsd, string Month, long ResetsAtMs)
{
    public bool Exhausted => SpentUsd >= BudgetUsd;
}

/// <summary>
/// The monthly spend on Claude calls, counted from each reply's <c>usage</c> (REQUIREMENTS.md FR-74, NFR-9) and, when a
/// <see cref="FeedbackBudgetStore"/> is given, kept in its file so a restart in the same UTC month resumes the count
/// . Without a store it is memory only. The check comes before a call and the count after it, so calls already in
/// flight when the cap is reached can each take the spend past it once.
/// </summary>
public sealed class FeedbackBudget
{
    private readonly Lock _gate = new();
    private readonly TimeProvider _time;
    private readonly IOptions<FeedbackOptions> _options;
    private readonly FeedbackBudgetStore? _store;
    private string _month = string.Empty;
    private decimal _spent;

    public FeedbackBudget(TimeProvider time, IOptions<FeedbackOptions> options, FeedbackBudgetStore? store = null)
    {
        _time = time;
        _options = options;
        _store = store;
        var saved = store?.Load();
        if (saved is not null)
        {
            // A saved month that is not this one is zeroed by the first Roll.
            _month = saved.Month;
            _spent = saved.SpentUsd;
        }
    }

    public BudgetState Current()
    {
        lock (_gate)
        {
            var (month, resetsAt) = Roll();
            return new BudgetState(_spent, _options.Value.MonthlyBudgetUsd, month, resetsAt);
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
            if (cost > 0m)
            {
                _store?.Save(new PersistedBudget(_month, _spent, _options.Value.MonthlyBudgetUsd));
            }
        }
    }

    private static string Month(DateTimeOffset now) => now.ToString(FeedbackBudgetStore.MonthFormat, CultureInfo.InvariantCulture);

    private (string Month, long ResetsAtMs) Roll()
    {
        var now = _time.GetUtcNow();
        var month = Month(now);
        if (month != _month)
        {
            _month = month;
            _spent = 0m;
        }

        var start = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero);
        return (month, start.AddMonths(1).ToUnixTimeMilliseconds());
    }
}
