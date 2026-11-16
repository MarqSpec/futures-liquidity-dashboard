using System.Globalization;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

/// <summary>Per-symbol counts for the headless market-hub smoke test. Holds no credentials.</summary>
public sealed class ProjectXSmokeReport
{
    private static readonly TimeZoneInfo Chicago = TimeZoneInfo.FindSystemTimeZoneById("America/Chicago");
    private readonly Dictionary<string, Symbol> _symbols = new(StringComparer.Ordinal);

    public void Observe(string symbol, string kind, DateTimeOffset? sourceUtc, DateTimeOffset receivedUtc)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(symbol);
        var row = _symbols.TryGetValue(symbol, out var existing) ? existing : _symbols[symbol] = new Symbol();
        row.Observe(kind, sourceUtc, receivedUtc);
    }

    public string Render()
    {
        if (_symbols.Count == 0)
        {
            return "No market-hub events.";
        }

        var lines = new List<string>();
        foreach (var (symbol, row) in _symbols.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            lines.Add(
                $"{symbol}  quotes={row.Quotes}  trades={row.Trades}  depth={row.Depth}  "
                + $"latencyMs={row.LatencyText()}  maxGapMs={(row.MaxGapMs is { } gap ? gap.ToString(CultureInfo.InvariantCulture) : "—")}");
            lines.Add($"  first {Symbol.Format(row.First)}");
            lines.Add($"  last  {Symbol.Format(row.Last)}");
        }

        return string.Join(Environment.NewLine, lines);
    }

    public static string FormatInstant(DateTimeOffset utc)
    {
        var chicago = TimeZoneInfo.ConvertTime(utc, Chicago);
        return $"{utc:yyyy-MM-dd HH:mm:ss.fff}Z  {chicago:yyyy-MM-dd HH:mm:ss.fff} CT";
    }

    private sealed class Symbol
    {
        private DateTimeOffset? _previousSource;

        public int Quotes { get; private set; }

        public int Trades { get; private set; }

        public int Depth { get; private set; }

        public DateTimeOffset? First { get; private set; }

        public DateTimeOffset? Last { get; private set; }

        public long? MaxGapMs { get; private set; }

        private readonly List<long> _latency = [];

        public void Observe(string kind, DateTimeOffset? sourceUtc, DateTimeOffset receivedUtc)
        {
            switch (kind)
            {
                case "quote":
                    Quotes++;
                    break;
                case "trade":
                    Trades++;
                    break;
                case "depth":
                    Depth++;
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(kind), kind, "Expected quote, trade or depth.");
            }

            var stamp = sourceUtc ?? receivedUtc;
            First ??= stamp;
            Last = stamp;
            if (sourceUtc is { } source)
            {
                if (_previousSource is { } previous && source > previous)
                {
                    var gap = (long)(source - previous).TotalMilliseconds;
                    MaxGapMs = MaxGapMs is { } current ? Math.Max(current, gap) : gap;
                }

                _previousSource = source;
                var latency = (long)(receivedUtc - source).TotalMilliseconds;
                if (latency >= 0 && latency < 86_400_000)
                {
                    _latency.Add(latency);
                }
            }
        }

        public string LatencyText()
        {
            if (_latency.Count == 0)
            {
                return "—";
            }

            var ordered = _latency.Order().ToList();
            return $"min {ordered[0]} / median {ordered[ordered.Count / 2]} / max {ordered[^1]}";
        }

        public static string Format(DateTimeOffset? instant) => instant is { } value ? FormatInstant(value) : "—";
    }
}
