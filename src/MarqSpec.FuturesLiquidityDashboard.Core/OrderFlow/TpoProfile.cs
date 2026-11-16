namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>One row of a market profile: its low price and the letters of the periods that traded there.</summary>
public sealed record TpoRow(long PriceTicks, string Letters)
{
    public int Count => Letters.Length;
}

/// <summary>A run of rows touched by one period only (REQUIREMENTS.md FR-51).</summary>
/// <param name="Tail">True when the run reaches the profile's top or bottom (a buying or selling tail).</param>
public sealed record SinglePrintRun(long LowTicks, long HighTicks, char Letter, bool Tail);

public sealed record TpoSnapshot(
    int RowTicks,
    int PeriodMinutes,
    long? SessionOpenMs,
    IReadOnlyList<TpoRow> Rows,
    long? PocTicks,
    IReadOnlyList<SinglePrintRun> SinglePrints,
    long? PartialSinceMs);

/// <summary>
/// Time-price-opportunity (market) profile for the session (ARCHITECTURE.md D-24). Each <c>TpoPeriodMinutes</c>
/// period from the session open gets a letter (A–Z, then a–z); every row of <c>rowTicks</c> it trades in gets that
/// letter once. The TPO POC is the row with the most letters (ties go to the lower row). Single prints are runs of
/// at least <c>SinglePrintMinRows</c> rows touched by exactly one period. Not thread-safe.
/// </summary>
public sealed class TpoProfile(int periodMinutes, int rowTicks)
{
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    private readonly SortedDictionary<long, ulong> _rows = [];
    private long? _openMs;
    private long? _partialSinceMs;

    public int RowTicks { get; } = Math.Max(1, rowTicks);

    public int PeriodMinutes { get; } = Math.Max(1, periodMinutes);

    private long PeriodMs => PeriodMinutes * 60_000L;

    public void Reset(long sessionOpenMs, long? partialSinceMs)
    {
        _rows.Clear();
        _openMs = sessionOpenMs;
        _partialSinceMs = partialSinceMs;
    }

    /// <summary>The period index of a time, or −1 before the session open.</summary>
    public int PeriodOf(long timeMs) => _openMs is { } open && timeMs >= open ? (int)((timeMs - open) / PeriodMs) : -1;

    public void Add(long timeMs, long priceTicks)
    {
        if (_openMs is { } open && timeMs < open && _rows.Count == 0)
        {
            // Prints before the session's official open (the synthetic market at a weekend, or a replay of a
            // closed period) start the letters at their own half hour rather than being dropped.
            _openMs = timeMs - (((timeMs % PeriodMs) + PeriodMs) % PeriodMs);
        }

        var period = PeriodOf(timeMs);
        if (period < 0 || period >= 64)
        {
            return;
        }

        var row = RowOf(priceTicks);
        _rows.TryGetValue(row, out var mask);
        _rows[row] = mask | (1UL << period);
    }

    public long RowOf(long priceTicks) => priceTicks - (((priceTicks % RowTicks) + RowTicks) % RowTicks);

    public TpoSnapshot Snapshot(int singlePrintMinRows)
    {
        var rows = _rows.Select(r => new TpoRow(r.Key, Letters(r.Value))).ToList();
        long? poc = rows.Count == 0 ? null : rows.OrderByDescending(r => r.Count).ThenBy(r => r.PriceTicks).First().PriceTicks;
        return new TpoSnapshot(RowTicks, PeriodMinutes, _openMs, rows, poc, SinglePrints(rows, singlePrintMinRows), _partialSinceMs);
    }

    public static char LetterFor(int period) => period >= 0 && period < Alphabet.Length ? Alphabet[period] : '?';

    private List<SinglePrintRun> SinglePrints(List<TpoRow> rows, int minRows)
    {
        var runs = new List<SinglePrintRun>();
        var i = 0;
        while (i < rows.Count)
        {
            if (rows[i].Count != 1)
            {
                i++;
                continue;
            }

            var j = i;
            while (j + 1 < rows.Count && rows[j + 1].Count == 1 && rows[j + 1].Letters == rows[i].Letters
                && rows[j + 1].PriceTicks == rows[j].PriceTicks + RowTicks)
            {
                j++;
            }

            if (j - i + 1 >= Math.Max(1, minRows))
            {
                runs.Add(new SinglePrintRun(rows[i].PriceTicks, rows[j].PriceTicks + RowTicks - 1, rows[i].Letters[0], i == 0 || j == rows.Count - 1));
            }

            i = j + 1;
        }

        return runs;
    }

    private static string Letters(ulong mask)
    {
        var chars = new List<char>();
        for (var p = 0; p < 64; p++)
        {
            if ((mask & (1UL << p)) != 0)
            {
                chars.Add(LetterFor(p));
            }
        }

        return new string([.. chars]);
    }
}
