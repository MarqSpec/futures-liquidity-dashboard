using System.Globalization;

namespace MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

/// <summary>A confirmed swing pivot on footprint bars, with the session CVD at that bar.</summary>
public sealed record SwingPivot(long BarStartMs, long PriceTicks, bool IsHigh, long Cvd, int BarIndex);

/// <summary>What one closed footprint bar produced at bar level.</summary>
public sealed record BarFlowResult(
    double? DeltaZ,
    IReadOnlyList<(SignalKind Kind, SignalBias Bias, long Low, long High, double Strength, string Label, string Detail)> Signals,
    IReadOnlyList<SwingPivot> NewPivots);

/// <summary>
/// The detectors that read whole bars (ARCHITECTURE.md D-21): the rolling delta distribution, delta spikes,
/// delta exhaustion, trapped traders, swing pivots and CVD divergence. It sees every closed footprint bar in order
/// and keeps the session CVD, which resets with the session. Not thread-safe.
/// </summary>
public sealed class BarFlowAnalyzer(OrderFlowOptions options)
{
    private readonly Queue<long> _deltas = new();
    private readonly List<BarPoint> _bars = [];
    private readonly List<SwingPivot> _pivots = [];
    private readonly List<TrapCandidate> _traps = [];
    private int _index;

    public long Cvd { get; private set; }

    public IReadOnlyList<SwingPivot> Pivots => _pivots;

    /// <summary>[bar end, CVD at close] for the session, oldest first.</summary>
    public IReadOnlyList<(long EndMs, long Cvd)> CvdSeries => _bars.Select(b => (b.EndMs, b.Cvd)).ToList();

    public void ResetSession()
    {
        Cvd = 0;
        _bars.Clear();
        _pivots.Clear();
        _traps.Clear();
    }

    /// <summary>Adds the delta of trades that are not yet in a closed bar, so the live CVD is current.</summary>
    public long LiveCvd(FootprintBar? developing) => Cvd + (developing?.Delta ?? 0);

    public BarFlowResult OnBarClosed(FootprintBar bar, IReadOnlyList<KeyLevel> levels)
    {
        ArgumentNullException.ThrowIfNull(bar);
        ArgumentNullException.ThrowIfNull(levels);
        var signals = new List<(SignalKind, SignalBias, long, long, double, string, string)>();
        var pivots = new List<SwingPivot>();
        if (bar.IsEmpty || bar.High is not { } high || bar.Low is not { } low || bar.Close is not { } close)
        {
            return new BarFlowResult(null, signals, pivots);
        }

        Cvd += bar.Delta;
        var z = DeltaZ(bar.Delta);
        _bars.Add(new BarPoint(bar.StartMs, bar.EndMs, high, low, close, Cvd, _index));
        var spike = z is { } zz && Math.Abs(zz) >= options.DeltaSpikeSigma;

        ResolveTraps(bar, signals);
        if (spike)
        {
            var buying = bar.Delta > 0;
            var extreme = buying ? high : low;
            var level = Nearest(levels, extreme);
            var near = level is not null && Math.Abs(level.PriceTicks - extreme) <= options.KeyLevelProximityTicks;
            var range = high - low;
            if (near && options.EnableDeltaExhaustion && range >= 2)
            {
                var position = (double)(close - low) / range;
                var stalled = buying ? position <= options.ExhaustionCloseFraction : position >= 1 - options.ExhaustionCloseFraction;
                if (stalled)
                {
                    var strength = Math.Min(1, (Math.Abs(z!.Value) - options.DeltaSpikeSigma + 1) / 3.0);
                    signals.Add((SignalKind.DeltaExhaustion, buying ? SignalBias.Bearish : SignalBias.Bullish, extreme, extreme, strength,
                        buying ? "Buying exhausted" : "Selling exhausted",
                        Invariant($"Delta {bar.Delta:+#;-#;0} ({z:0.0}σ) into {level!.Name}, bar closed at {position:P0} of range")));
                }
            }

            if (near && options.EnableTrappedTraders)
            {
                _traps.Add(new TrapCandidate(_index, buying, high, low, bar.Delta, z!.Value, level!.Name));
            }
        }

        // Swing pivots are confirmed SwingStrengthBars after the pivot bar.
        var n = options.SwingStrengthBars;
        if (_bars.Count >= (2 * n) + 1)
        {
            var mid = _bars[^(n + 1)];
            var window = _bars.Skip(_bars.Count - ((2 * n) + 1)).ToList();
            if (window.Where(b => b != mid).All(b => b.High < mid.High))
            {
                pivots.Add(AddPivot(new SwingPivot(mid.StartMs, mid.High, IsHigh: true, mid.Cvd, mid.Index), signals));
            }

            if (window.Where(b => b != mid).All(b => b.Low > mid.Low))
            {
                pivots.Add(AddPivot(new SwingPivot(mid.StartMs, mid.Low, IsHigh: false, mid.Cvd, mid.Index), signals));
            }
        }

        _index++;
        return new BarFlowResult(z, signals, pivots);
    }

    private SwingPivot AddPivot(SwingPivot pivot, List<(SignalKind, SignalBias, long, long, double, string, string)> signals)
    {
        var previous = _pivots.LastOrDefault(p => p.IsHigh == pivot.IsHigh);
        _pivots.Add(pivot);
        if (_pivots.Count > 40)
        {
            _pivots.RemoveAt(0);
        }

        if (!options.EnableCvdDivergence || previous is null || pivot.BarIndex - previous.BarIndex > options.DivergenceMaxBars)
        {
            return pivot;
        }

        var scale = Math.Max(1, _deltas.Count == 0 ? 1 : _deltas.Average(d => Math.Abs((double)d)) * 3);
        if (pivot.IsHigh && pivot.PriceTicks > previous.PriceTicks && pivot.Cvd < previous.Cvd)
        {
            signals.Add((SignalKind.CvdDivergence, SignalBias.Bearish, pivot.PriceTicks, pivot.PriceTicks,
                Math.Min(1, (previous.Cvd - pivot.Cvd) / scale), "Bearish CVD divergence",
                Invariant($"Higher high ({previous.PriceTicks}→{pivot.PriceTicks} ticks) on lower CVD ({previous.Cvd}→{pivot.Cvd})")));
        }
        else if (!pivot.IsHigh && pivot.PriceTicks < previous.PriceTicks && pivot.Cvd > previous.Cvd)
        {
            signals.Add((SignalKind.CvdDivergence, SignalBias.Bullish, pivot.PriceTicks, pivot.PriceTicks,
                Math.Min(1, (pivot.Cvd - previous.Cvd) / scale), "Bullish CVD divergence",
                Invariant($"Lower low ({previous.PriceTicks}→{pivot.PriceTicks} ticks) on higher CVD ({previous.Cvd}→{pivot.Cvd})")));
        }

        return pivot;
    }

    private void ResolveTraps(FootprintBar bar, List<(SignalKind, SignalBias, long, long, double, string, string)> signals)
    {
        foreach (var trap in _traps.ToList())
        {
            var age = _index - trap.Index;
            if (age > options.TrappedReversalBars)
            {
                _traps.Remove(trap);
                continue;
            }

            if (age < 1)
            {
                continue;
            }

            var reversed = trap.Buying ? bar.Close < trap.Low : bar.Close > trap.High;
            if (reversed)
            {
                _traps.Remove(trap);
                var strength = Math.Min(1, (Math.Abs(trap.Z) - options.DeltaSpikeSigma + 1) / 3.0);
                signals.Add((SignalKind.TrappedTraders, trap.Buying ? SignalBias.Bearish : SignalBias.Bullish, trap.Low, trap.High, strength,
                    trap.Buying ? "Trapped buyers" : "Trapped sellers",
                    Invariant($"Delta {trap.Delta:+#;-#;0} ({trap.Z:0.0}σ) at {trap.Level}, then closed beyond the spike bar within {age} bar(s)")));
            }
        }
    }

    private double? DeltaZ(long delta)
    {
        double? z = null;
        if (_deltas.Count >= options.DeltaMinSamples)
        {
            var mean = _deltas.Average(d => (double)d);
            var sd = Math.Sqrt(_deltas.Average(d => Math.Pow(d - mean, 2)));
            z = sd > 0 ? (delta - mean) / sd : null;
        }

        _deltas.Enqueue(delta);
        while (_deltas.Count > options.DeltaLookbackBars)
        {
            _deltas.Dequeue();
        }

        return z;
    }

    private static KeyLevel? Nearest(IReadOnlyList<KeyLevel> levels, long price) =>
        levels.Count == 0 ? null : levels.MinBy(l => Math.Abs(l.PriceTicks - price));

    private static string Invariant(FormattableString text) => text.ToString(CultureInfo.InvariantCulture);

    private sealed record BarPoint(long StartMs, long EndMs, long High, long Low, long Close, long Cvd, int Index);

    private sealed record TrapCandidate(int Index, bool Buying, long High, long Low, long Delta, double Z, string Level);
}
