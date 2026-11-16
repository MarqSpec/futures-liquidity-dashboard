using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Heatmap;

/// <summary>
/// Integrates the book over time into fixed slices (ARCHITECTURE.md, Slice integrator). Call <see cref="Advance"/>
/// with the event time before every change to the book, so the state that held until then is credited to the
/// elapsed milliseconds; then apply the change. Only covered prices whose size is known accumulate known time (REQUIREMENTS.md FR-11,
/// FR-12). After a gap of more than <see cref="MaxCatchUpSlices"/> slices, only the most recent ones are built.
/// </summary>
public sealed class SliceIntegrator(int sliceMs = 1000)
{
    private readonly Dictionary<long, (double Bid, double Ask, int KnownMs)> _cells = [];
    private long _sliceStart = long.MinValue;
    private long _lastMs = long.MinValue;

    public int SliceMs { get; } = sliceMs > 0 ? sliceMs : throw new ArgumentOutOfRangeException(nameof(sliceMs));

    /// <summary>The most empty slices one call builds after a gap: two hours of 1 s slices.</summary>
    public const int MaxCatchUpSlices = 7_200;

    /// <summary>Credits the current book state up to <paramref name="nowMs"/>; returns every slice that closed.</summary>
    public IReadOnlyList<HeatmapColumn> Advance(long nowMs, OrderBook book)
    {
        ArgumentNullException.ThrowIfNull(book);
        var closed = new List<HeatmapColumn>();
        if (_lastMs == long.MinValue)
        {
            _lastMs = nowMs;
            _sliceStart = Floor(nowMs);
            return closed;
        }

        if (nowMs <= _lastMs)
        {
            return closed;
        }

        if ((nowMs - _sliceStart) / SliceMs > MaxCatchUpSlices)
        {
            // A long gap (an outage, or a bad timestamp) would build millions of empty columns under the engine lock:
            // close the open slice and build only the most recent MaxCatchUpSlices, which retention keeps anyway.
            var end = _sliceStart + SliceMs;
            Credit(book, (int)(end - _lastMs));
            closed.Add(Close());
            _sliceStart = Floor(nowMs) - (MaxCatchUpSlices * SliceMs);
            _lastMs = _sliceStart;
        }

        while (nowMs >= _sliceStart + SliceMs)
        {
            var end = _sliceStart + SliceMs;
            Credit(book, (int)(end - _lastMs));
            closed.Add(Close());
            _sliceStart = end;
            _lastMs = end;
        }

        Credit(book, (int)(nowMs - _lastMs));
        _lastMs = nowMs;
        return closed;
    }

    private void Credit(OrderBook book, int elapsedMs)
    {
        if (elapsedMs <= 0 || !book.IsKnown || book.CoveredLow is not { } low || book.CoveredHigh is not { } high)
        {
            return;
        }

        for (var price = low; price <= high; price++)
        {
            // A covered tick can still be unknown (its level was trimmed and has not been updated since): it earns no
            // known time, so the heatmap never draws it as known and empty (REQUIREMENTS.md FR-11, FR-12).
            if (book.QuantityAt(BookSide.Bid, price) is not { } bid || book.QuantityAt(BookSide.Ask, price) is not { } ask)
            {
                continue;
            }

            _cells.TryGetValue(price, out var cell);
            _cells[price] = (cell.Bid + (bid * (double)elapsedMs), cell.Ask + (ask * (double)elapsedMs), cell.KnownMs + elapsedMs);
        }
    }

    private HeatmapColumn Close()
    {
        var cells = _cells
            .OrderBy(c => c.Key)
            .Select(c => new HeatCell(c.Key, c.Value.Bid, c.Value.Ask, c.Value.KnownMs))
            .ToList();
        _cells.Clear();
        return new HeatmapColumn(_sliceStart, SliceMs, cells);
    }

    private long Floor(long ms) => ms - (((ms % SliceMs) + SliceMs) % SliceMs);
}
