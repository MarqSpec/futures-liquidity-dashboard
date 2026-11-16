using System.Globalization;
using System.Text;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Agent;

/// <summary>
/// The built-in reference agent (REQUIREMENTS.md UC-5; ARCHITECTURE.md D-17). It reads only the read-only context an
/// external agent would get from <c>GET /api/context/{instrument}</c> and publishes through the same validated
/// overlay path as <c>POST /api/overlays/{instrument}</c>, so the overlay contract is exercised end to end without a
/// third-party model. It derives levels mechanically (VWAP bands, value area, prior-session extremes, the strongest
/// iceberg) and writes a plain-text rationale; it never trades and holds no credentials.
/// </summary>
public sealed partial class ReferenceOverlayAgent(
    EngineRegistry registry,
    OverlayStore overlays,
    TimeProvider time,
    IConfiguration configuration,
    ILogger<ReferenceOverlayAgent> logger) : BackgroundService
{
    public const string Publisher = "reference-agent";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!configuration.GetValue("Agent:Enabled", true))
        {
            return;
        }

        var period = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue("Agent:IntervalSeconds", 60), 5, 3600));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue("Agent:FirstRunSeconds", 15), 0, 600)), time, stoppingToken)
                .ConfigureAwait(false);
            using var timer = new PeriodicTimer(period, time);
            do
            {
                foreach (var engine in registry.All)
                {
                    var request = Build(engine.Context(), time.GetUtcNow(), period * 3);
                    if (request is null)
                    {
                        continue;
                    }

                    var result = overlays.Publish(engine.Spec.Root, request, Publisher);
                    if (!result.Accepted)
                    {
                        Log.Rejected(logger, engine.Spec.Root.ToString(), result.Rejection.ToString(), result.Message);
                    }
                }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false));
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    /// <summary>The overlay for one context, or null while there is nothing to anchor it (no last price yet).</summary>
    public static OverlayRequest? Build(AgentContext context, DateTimeOffset now, TimeSpan lifetime)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (context.LastPrice is not { } last)
        {
            return null;
        }

        var info = context.Instrument;
        var tickSize = info.TickSize;
        decimal ToPrice(long ticks) => ticks * tickSize;
        var levels = new List<OverlayLevel>();
        void Add(decimal? price, string label, string kind)
        {
            if (price is { } p && p > 0 && levels.TrueForAll(l => l.Price != p) && levels.Count < OverlayStore.MaxLevels)
            {
                levels.Add(new OverlayLevel { Price = p, Label = label, Kind = kind });
            }
        }

        decimal? Snap(double? price) => price is { } v && double.IsFinite(v)
            ? (decimal)Math.Round(v / (double)tickSize) * tickSize
            : null;
        string KindOf(decimal price) => price >= last ? "resistance" : "support";

        if (Snap(context.Vwap.Vwap) is { } vwap)
        {
            Add(vwap, "VWAP", "reference");
            if (Snap(context.Vwap.StdDev) is { } sd && sd > 0)
            {
                Add(vwap + sd, "VWAP +1σ", "resistance");
                Add(vwap - sd, "VWAP −1σ", "support");
            }
        }

        if (context.Profiles.FirstOrDefault(p => p.Window == "session") is { } session)
        {
            if (session.Poc is { } poc)
            {
                Add(ToPrice(poc), "Session POC", KindOf(ToPrice(poc)));
            }

            if (session.Vah is { } vah)
            {
                Add(ToPrice(vah), "Value area high", KindOf(ToPrice(vah)));
            }

            if (session.Val is { } val)
            {
                Add(ToPrice(val), "Value area low", KindOf(ToPrice(val)));
            }
        }

        foreach (var level in context.KeyLevels.Where(k => k.Name.StartsWith("prior", StringComparison.OrdinalIgnoreCase)))
        {
            Add(ToPrice(level.PriceTicks), char.ToUpperInvariant(level.Name[0]) + level.Name[1..], level.IsHigh ? "resistance" : "support");
        }

        if (context.Icebergs.Where(i => i.Active).MaxBy(i => i.Confidence) is { } iceberg && iceberg.Confidence >= 0.5)
        {
            var price = ToPrice(iceberg.PriceTicks);
            Add(price, string.Create(CultureInfo.InvariantCulture, $"Inferred iceberg {iceberg.Side} ~{iceberg.HiddenEstimate} hidden"), KindOf(price));
        }

        var rationale = new StringBuilder();
        rationale.Append(CultureInfo.InvariantCulture, $"Last {last.ToString("F" + info.PriceDecimals.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture)}. ");
        if (Snap(context.Vwap.Vwap) is { } v2)
        {
            rationale.Append(last >= v2 ? "Trading above VWAP. " : "Trading below VWAP. ");
        }

        rationale.Append(CultureInfo.InvariantCulture, $"Session CVD {context.Cvd:+#;-#;0}. ");
        if (context.Indicators.TryGetValue("rsi14", out var rsi) && rsi.Count > 0 && rsi[0] is { } r)
        {
            rationale.Append(CultureInfo.InvariantCulture, $"RSI 14 at {r:0.0}. ");
        }

        if (context.RecentSignals.Count > 0)
        {
            var signal = context.RecentSignals[^1];
            rationale.Append(CultureInfo.InvariantCulture, $"Latest signal: {signal.Label}. ");
        }

        rationale.Append("Mechanical reference levels, not advice.");
        var flags = new List<string>();
        if (!context.Status.BookKnown)
        {
            flags.Add("book-unknown");
        }

        if (context.Status.Code is not ("LIVE" or "REPLAY" or "SIMULATED"))
        {
            flags.Add($"status-{context.Status.Code.ToLowerInvariant()}");
        }

        var asOf = DateTimeOffset.FromUnixTimeMilliseconds(Math.Min(context.AsOfMs, now.ToUnixTimeMilliseconds()));
        return new OverlayRequest
        {
            ContractId = context.Instrument.ContractId,
            Version = now.ToUnixTimeMilliseconds(),
            GeneratedAt = now,
            AsOf = asOf,
            ExpiresAt = now + lifetime,
            SourceCoverage = Math.Clamp(context.Status.RecentCoverage, 0, 1),
            Levels = levels,
            Rationale = rationale.ToString(),
            QualityFlags = flags,
        };
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "Reference overlay for {Instrument} rejected: {Reason} {Message}")]
        public static partial void Rejected(ILogger logger, string instrument, string reason, string message);
    }
}
