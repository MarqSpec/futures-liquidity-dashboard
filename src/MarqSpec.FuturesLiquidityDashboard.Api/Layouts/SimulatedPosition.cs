using System.Globalization;
using System.Text.RegularExpressions;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

/// <summary>
/// One simulated position on a product (REQUIREMENTS.md FR-72, UC-20): a chart annotation kept on the saved layout, keyed by
/// product root. It is never an order and nothing here reaches a broker (REQUIREMENTS.md FR-6; ARCHITECTURE.md D-57).
/// Prices are whole ticks, so a fractional price is off the tick grid and refused. The tracking fields
/// (<see cref="State"/>, <see cref="Fill"/>, <see cref="Exits"/>) are validated here; a later change writes them.
/// </summary>
public sealed record SimulatedPosition
{
    public const int MaxQuantity = 100;
    public const int MaxTargets = 3;

    /// <summary>Every tick price is at most 1,000,000,000 ticks from zero.</summary>
    public const decimal MaxAbsTicks = 1_000_000_000m;

    public static IReadOnlySet<string> States { get; } = new HashSet<string>(StringComparer.Ordinal) { "planned", "working", "filled", "closed" };

    public static IReadOnlySet<string> ExitKinds { get; } = new HashSet<string>(StringComparer.Ordinal) { "stop", "target" };

    /// <summary><c>long</c> or <c>short</c>.</summary>
    public string Side { get; init; } = string.Empty;

    /// <summary><c>limit</c> or <c>market</c>.</summary>
    public string EntryType { get; init; } = string.Empty;

    /// <summary>Required for a limit. A market entry may carry the price it was drawn at, which the side checks then use. With none, each target must still be beyond the stop.</summary>
    public decimal? EntryTicks { get; init; }

    /// <summary>Contracts, a whole number from 1 to 100.</summary>
    public int Quantity { get; init; }

    public decimal StopTicks { get; init; }

    public List<PositionTarget> Targets { get; init; } = [];

    /// <summary>The root's contract when the position was made. A position for any other contract is dropped on read.</summary>
    public string ContractId { get; init; } = string.Empty;

    public long CreatedMs { get; init; }

    /// <summary><c>planned</c>, <c>working</c>, <c>filled</c> or <c>closed</c>.</summary>
    public string State { get; init; } = "planned";

    public PositionFill? Fill { get; init; }

    public List<PositionExit> Exits { get; init; } = [];

    /// <summary>Every problem with this position, each naming <paramref name="path"/> and the field.</summary>
    internal IEnumerable<string> Validate(string path)
    {
        var errors = new List<string>();
        var isLong = Side == "long";
        if (Side is not ("long" or "short"))
        {
            errors.Add($"{path}.Side must be long or short.");
        }

        if (EntryType is not ("limit" or "market"))
        {
            errors.Add($"{path}.EntryType must be limit or market.");
        }

        if (Quantity is < 1 or > MaxQuantity)
        {
            errors.Add($"{path}.Quantity must be a whole number from 1 to {MaxQuantity}.");
        }

        if (string.IsNullOrWhiteSpace(ContractId) || ContractId.Length > 32)
        {
            errors.Add($"{path}.ContractId must be a contract id of 1 to 32 characters.");
        }

        if (CreatedMs <= 0)
        {
            errors.Add($"{path}.CreatedMs must be a positive time in milliseconds.");
        }

        if (EntryType == "limit" && EntryTicks is null)
        {
            errors.Add($"{path}.EntryTicks is required for a limit entry.");
        }

        if (EntryTicks is { } entryOnGrid)
        {
            CheckTicks(errors, $"{path}.EntryTicks", entryOnGrid);
        }

        CheckTicks(errors, $"{path}.StopTicks", StopTicks);

        var sided = Side is "long" or "short" && EntryTicks is not null;
        if (sided && EntryTicks is { } entry && (isLong ? StopTicks >= entry : StopTicks <= entry))
        {
            errors.Add($"{path}.StopTicks must be {(isLong ? "below" : "above")} the entry for a {Side}.");
        }

        ValidateTargets(path, errors, sided, isLong);
        ValidateTracking(path, errors);
        return errors;
    }

    private void ValidateTargets(string path, List<string> errors, bool sided, bool isLong)
    {
        if (Targets is null)
        {
            errors.Add($"{path}.Targets must be a list, not null.");
            return;
        }

        if (Targets.Count > MaxTargets)
        {
            errors.Add($"{path}.Targets holds at most three targets.");
        }

        for (var i = 0; i < Targets.Count; i++)
        {
            var target = Targets[i];
            var at = $"{path}.Targets[{i}]";
            if (target is null)
            {
                errors.Add($"{at} must not be null.");
                continue;
            }

            if (target.Quantity is < 1 or > MaxQuantity)
            {
                errors.Add($"{at}.Quantity must be a whole number from 1 to {MaxQuantity}.");
            }

            CheckTicks(errors, $"{at}.PriceTicks", target.PriceTicks);

            if (sided && EntryTicks is { } entry && (isLong ? target.PriceTicks <= entry : target.PriceTicks >= entry))
            {
                errors.Add($"{at}.PriceTicks must be {(isLong ? "above" : "below")} the entry for a {Side}.");
            }
            else if (Side is "long" or "short" && EntryTicks is null && (isLong ? target.PriceTicks <= StopTicks : target.PriceTicks >= StopTicks))
            {
                errors.Add($"{at}.PriceTicks must be {(isLong ? "above" : "below")} the stop for a {Side} with no entry price.");
            }
        }

        var total = Targets.Where(t => t is not null).Sum(t => (long)t.Quantity);
        if (total > Quantity)
        {
            errors.Add($"{path}.Targets quantities sum to {total}, more than the position's {Quantity}.");
        }
    }

    private void ValidateTracking(string path, List<string> errors)
    {
        if (State is null || !States.Contains(State))
        {
            errors.Add($"{path}.State must be planned, working, filled or closed.");
            return;
        }

        var filled = State is "filled" or "closed";
        if (filled && Fill is null)
        {
            errors.Add($"{path}.Fill is required when the state is {State}.");
        }

        if (!filled && Fill is not null)
        {
            errors.Add($"{path}.Fill must be omitted when the state is {State}.");
        }

        if (Fill is { } fill)
        {
            if (fill.TimeMs <= 0)
            {
                errors.Add($"{path}.Fill.TimeMs must be a positive time in milliseconds.");
            }

            CheckTicks(errors, $"{path}.Fill.PriceTicks", fill.PriceTicks);

            if (fill.RiskTicks is { } risk)
            {
                if (risk < 1)
                {
                    errors.Add($"{path}.Fill.RiskTicks must be at least 1 tick.");
                }
                else
                {
                    CheckTicks(errors, $"{path}.Fill.RiskTicks", risk);
                }
            }
        }

        if (Exits is null)
        {
            errors.Add($"{path}.Exits must be a list, not null.");
            return;
        }

        if (!filled && Exits.Count > 0)
        {
            errors.Add($"{path}.Exits must be empty when the state is {State}.");
        }

        for (var i = 0; i < Exits.Count; i++)
        {
            var exit = Exits[i];
            var at = $"{path}.Exits[{i}]";
            if (exit is null)
            {
                errors.Add($"{at} must not be null.");
                continue;
            }

            if (exit.Kind is null || !ExitKinds.Contains(exit.Kind))
            {
                errors.Add($"{at}.Kind must be stop or target.");
            }

            if (exit.Quantity < 1)
            {
                errors.Add($"{at}.Quantity must be at least 1.");
            }

            if (exit.TimeMs <= 0)
            {
                errors.Add($"{at}.TimeMs must be a positive time in milliseconds.");
            }

            CheckTicks(errors, $"{at}.PriceTicks", exit.PriceTicks);
        }

        var exited = Exits.Where(e => e is not null).Sum(e => (long)e.Quantity);
        if (exited > Quantity)
        {
            errors.Add($"{path}.Exits quantities sum to {exited}, more than the position's {Quantity}.");
        }
    }

    // A price far outside any contract's range would overflow the tick arithmetic downstream. Negative prices stay
    // allowed: a futures price can trade below zero.
    private static void CheckTicks(List<string> errors, string field, decimal ticks)
    {
        if (Math.Abs(ticks) > MaxAbsTicks)
        {
            errors.Add($"{field} is out of range: {Show(ticks)} is more than 1,000,000,000 ticks from zero.");
        }
        else if (!OnGrid(ticks))
        {
            errors.Add($"{field} is off the tick grid: {Show(ticks)} is not a whole number of ticks.");
        }
    }

    private static bool OnGrid(decimal ticks) => decimal.Truncate(ticks) == ticks;

    private static string Show(decimal value) => value.ToString(CultureInfo.InvariantCulture);
}

/// <summary>A profit target: a price in ticks and the contracts it takes off.</summary>
public sealed record PositionTarget
{
    public decimal PriceTicks { get; init; }

    public int Quantity { get; init; }
}

/// <summary>Where and when an entry filled (tracking; REQUIREMENTS.md FR-72).</summary>
public sealed record PositionFill
{
    public long TimeMs { get; init; }

    public decimal PriceTicks { get; init; }

    /// <summary>
    /// The entry-to-stop distance in ticks as it stood at the fill, the basis of R (reference:
    /// ARCHITECTURE.md D-59). Optional,
    /// since a fill saved before it has none; when present it is a positive whole number within the tick bound.
    /// </summary>
    public decimal? RiskTicks { get; init; }
}

/// <summary>One exit of a filled position: <c>stop</c> or <c>target</c> (tracking; REQUIREMENTS.md FR-72).</summary>
public sealed record PositionExit
{
    public long TimeMs { get; init; }

    public decimal PriceTicks { get; init; }

    public int Quantity { get; init; }

    public string Kind { get; init; } = string.Empty;
}

/// <summary>Validates the positions map of a layout.</summary>
internal static partial class PositionRules
{
    [GeneratedRegex("^[A-Z0-9]{1,6}$")]
    private static partial Regex Root();

    internal static IEnumerable<string> Validate(Dictionary<string, SimulatedPosition>? positions)
    {
        if (positions is null)
        {
            yield return "Positions must be a map of product root to position, not null.";
            yield break;
        }

        foreach (var (root, position) in positions)
        {
            if (!Root().IsMatch(root ?? string.Empty))
            {
                yield return $"Positions key '{root}' is not a product root.";
                continue;
            }

            if (position is null)
            {
                yield return $"Positions[{root}] must not be null.";
                continue;
            }

            foreach (var error in position.Validate($"Positions[{root}]"))
            {
                yield return error;
            }
        }
    }
}
