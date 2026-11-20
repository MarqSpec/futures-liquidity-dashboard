using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Engine;

// (REQUIREMENTS.md FR-83, FR-39, FR-57)
public sealed class InstrumentEngineTapeTests
{
    private const long Px = TestData.EsBase;
    private static readonly long T0 = TestData.EpochMs;

    [Fact]
    public void Summary_ShouldReportAThinTapeAgainstItsOwnMedian_WhenTheRateFallsAfterHalfAnHourOfFourASecond()
    {
        var engine = BusyHalfHourEngine();
        engine.Apply(TestData.Trade(T0 + 8_000, Px, 1, BookSide.Bid, "quiet-1"));
        engine.Tick(T0 + 9_999);

        var tape = engine.Summary().Tape;

        tape.Should().NotBeNull();
        tape!.State.Should().Be(TapeState.Thin);
        (tape.Rate, tape.BaselineRate, tape.ThinBelowRate, tape.BaselineMinutes).Should().Be((0.1, 4.0, 1.0, 30));
    }

    [Fact]
    public void Snapshot_ShouldCarryTheSameTapeReadingAsTheSummary_WhenTheTapeIsActive()
    {
        var engine = BusyHalfHourEngine();
        engine.Apply(TestData.Trade(T0 + 8_000, Px, 40, BookSide.Bid, "busy-live"));
        engine.Tick(T0 + 9_999);

        var liquidity = engine.Snapshot(60, null).Liquidity;

        liquidity.Tape.State.Should().Be(TapeState.Active);
        liquidity.Tape.Should().Be(engine.Summary().Tape);
        liquidity.Tape.Rate.Should().Be(liquidity.TradeRate, "once the warmup has left the 10 s window the rate is FR-39's");
    }

    [Fact]
    public void Summary_ShouldReportNoBaseline_WhenTheEngineHasSeenLessThanThirtyMinutes()
    {
        var engine = NewEngine(StackedOnly());
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        engine.Apply(TestData.Trade(T0 + 1_000, Px, 5, BookSide.Bid, "early"));

        var tape = engine.Summary().Tape!;

        tape.State.Should().Be(TapeState.Unknown);
        (tape.BaselineRate, tape.ThinBelowRate).Should().Be((null, null));
    }

    [Fact]
    public void Apply_ShouldTagASignalThinTape_WhenItIsRaisedWhileTheTapeIsThin()
    {
        var engine = BusyHalfHourEngine();

        PlayStackedBar(engine, T0);

        var signal = engine.Snapshot(60, null).OrderFlow.Signals.Should().ContainSingle(s => s.Kind == SignalKind.StackedImbalance).Subject;
        signal.ThinTape.Should().BeTrue("the bar closed with nothing printed in its last 10 s against a 4/s median");
    }

    [Fact]
    public void Apply_ShouldLeaveASignalUntagged_WhenTheTapeHasNoBaselineYet()
    {
        var engine = NewEngine(StackedOnly());
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));

        PlayStackedBar(engine, T0);

        var signal = engine.Snapshot(60, null).OrderFlow.Signals.Should().ContainSingle(s => s.Kind == SignalKind.StackedImbalance).Subject;
        signal.ThinTape.Should().BeFalse("with no baseline nothing is called thin");
    }

    [Fact]
    public void Constructor_ShouldJudgeTheTapeByTheConfiguredShare_WhenEngineTapeDiffersFromTheDefault()
    {
        var engine = BusyHalfHourEngine(StackedOnly() with { Tape = new TapeOptions { ThinRatio = 0.01 } });
        engine.Apply(TestData.Trade(T0 + 8_000, Px, 1, BookSide.Bid, "quiet-1"));
        engine.Tick(T0 + 9_999);

        var tape = engine.Summary().Tape!;

        tape.State.Should().Be(TapeState.Active, "0.1/s is above 1 % of 4.0/s");
        tape.ThinBelowRate.Should().BeApproximately(0.04, 1e-12);
    }

    // (the ruling A: no reading on an unhealthy feed)
    [Fact]
    public void Summary_ShouldReportNoReading_WhenTheFeedIsStale()
    {
        var engine = BusyHalfHourEngine();
        engine.Apply(TestData.Trade(T0 + 1_000, Px, 1, BookSide.Bid, "quiet-1"));
        engine.Tick(T0 + 9_999);

        var stale = engine.Summary();

        engine.Status().Code.Should().Be("STALE");
        stale.Tape!.State.Should().Be(TapeState.Unknown, "nothing has arrived for 9 s: a quiet tape cannot be told from a silent feed");
        (stale.Tape.BaselineRate, stale.Tape.ThinBelowRate).Should().Be((null, null));
        stale.Tape.Rate.Should().Be(0.1);
    }

    // (the ruling A)
    [Fact]
    public void Summary_ShouldReportNoReading_WhenTheFeedIsRecovering()
    {
        var engine = BusyHalfHourEngine();
        engine.Apply(TestData.Trade(T0 + 8_000, Px, 1, BookSide.Bid, "quiet-1"));
        engine.Apply(TestData.Status(T0 + 9_000, connected: false));
        engine.Tick(T0 + 9_999);

        engine.Status().Code.Should().Be("RECOVERING");
        engine.Summary().Tape!.State.Should().Be(TapeState.Unknown);
        engine.Snapshot(60, null).Liquidity.Tape.State.Should().Be(TapeState.Unknown);
    }

    // (the ruling A)
    [Fact]
    public void Apply_ShouldLeaveASignalUntagged_WhenItIsRaisedWhileTheFeedIsStale()
    {
        var engine = BusyHalfHourEngine();

        PlayStackedBar(engine, T0, keepAlive: false);

        var signal = engine.Snapshot(60, null).OrderFlow.Signals.Should().ContainSingle(s => s.Kind == SignalKind.StackedImbalance).Subject;
        signal.ThinTape.Should().BeFalse("the bar closed 59 s after the last event, with the feed STALE");
    }

    [Fact]
    public void Summary_ShouldReportNoReadingAndFr39sRate_WhenTheLastWarmupPrintIsUnderTenSecondsOld()
    {
        var engine = BusyHalfHourEngine();

        var summary = engine.Summary();

        summary.Tape!.State.Should().Be(TapeState.Unknown, "the 10 s window still holds warmup, which the live rate does not count");
        summary.Tape.Rate.Should().Be(summary.TradeRate);
    }

    // (the zero-median ruling: the daily break reads Unknown)
    [Theory]
    [InlineData(1)]
    [InlineData(5)]
    [InlineData(14)]
    public void Summary_ShouldReportNoReading_WhenTheExchangeHasClosedWhileTheMedianIsStillAboveZero(int minutesAfter)
    {
        var engine = BusyHourToTheCloseEngine(Close - 25_000);

        engine.Tick(Close + (minutesAfter * 60_000L));

        engine.Status().Code.Should().Be("SIMULATED", "the feed is healthy; only the exchange is shut");
        var tape = engine.Summary().Tape!;
        tape.State.Should().Be(TapeState.Unknown, "the market is closed, not thin");
        (tape.BaselineRate, tape.ThinBelowRate).Should().Be((null, null));
    }

    [Fact]
    public void Summary_ShouldReportThin_WhenTheTapeFallsQuietJustBeforeTheClose()
    {
        var engine = BusyHourToTheCloseEngine(Close - 25_000);

        engine.Tick(Close - 1);

        engine.Summary().Tape!.State.Should().Be(TapeState.Thin, "the exchange is still open at 15:59:59.999 CT");
    }

    [Fact]
    public void Apply_ShouldLeaveASignalUntagged_WhenTheClockClosesItsBarAfterTheExchangeHasClosed()
    {
        var engine = BusyHourToTheCloseEngine(Close - 65_000, quietPrint: false);

        PlayStackedBar(engine, Close - 60_000, keepAlive: false, closeAt: Close + 60_000);

        var signal = engine.Snapshot(60, null).OrderFlow.Signals.Should().ContainSingle(s => s.Kind == SignalKind.StackedImbalance).Subject;
        signal.ThinTape.Should().BeFalse("the bar closed a minute after 16:00 CT, with the exchange shut");
    }

    /// <summary>16:00 CT on Tuesday 2026-11-10 (22:00 UTC in the fixed test zone): the daily close.</summary>
    private static readonly long Close = new DateTimeOffset(2026, 11, 10, 22, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();

    /// <summary>
    /// Warmup at 4 contracts a second from an hour before <see cref="Close"/> until shortly before
    /// <paramref name="liveFromMs"/>, connected there with a known book, and, unless <paramref name="quietPrint"/> is
    /// false, one print 2 s before the close to keep the feed fresh.
    /// </summary>
    private static InstrumentEngine BusyHourToTheCloseEngine(long liveFromMs, bool quietPrint = true)
    {
        var engine = NewEngine(StackedOnly());
        var from = Close - (60 * 60_000);
        var history = new List<TradeEvent>();
        for (var t = from; t < liveFromMs - 5_000; t += 10_000)
        {
            history.Add(TestData.Trade(t, Px, 20, BookSide.Bid, $"c{t}-b"));
            history.Add(TestData.Trade(t + 1, Px, 20, BookSide.Ask, $"c{t}-a"));
        }

        engine.LoadHistory(history, from);
        engine.Apply(TestData.Status(liveFromMs, connected: true));
        engine.Apply(TestData.Snapshot(liveFromMs));
        if (quietPrint)
        {
            engine.Apply(TestData.Trade(Close - 2_000, Px, 1, BookSide.Bid, "last-before-close"));
        }

        return engine;
    }

    /// <summary>Half an hour of warmup history at 4 contracts a second (40 every 10 s), then connected with a known book at <see cref="T0"/>.</summary>
    private static InstrumentEngine BusyHalfHourEngine(EngineOptions? options = null)
    {
        var engine = NewEngine(options ?? StackedOnly());
        var from = T0 - (30 * 60_000);
        var history = new List<TradeEvent>();
        for (var t = from; t < T0; t += 10_000)
        {
            history.Add(TestData.Trade(t, Px, 20, BookSide.Bid, $"h{t}-b"));
            history.Add(TestData.Trade(t + 1, Px, 20, BookSide.Ask, $"h{t}-a"));
        }

        engine.LoadHistory(history, from);
        engine.Apply(TestData.Status(T0, connected: true));
        engine.Apply(TestData.Snapshot(T0));
        return engine;
    }

    /// <summary>
    /// One minute's stacked buy imbalance from 1 s into the minute, closed by the clock at the minute's end. With
    /// <paramref name="keepAlive"/> a book change 1 s before the close keeps the feed from going STALE.
    /// </summary>
    private static void PlayStackedBar(InstrumentEngine engine, long start, bool keepAlive = true, long? closeAt = null)
    {
        var t = start + 1_000;
        foreach (var (offset, bid, ask) in new (int Offset, long Bid, long Ask)[] { (0, 2, 0), (1, 2, 6), (2, 2, 6), (3, 1, 6) })
        {
            var price = Px + 10 + offset;
            if (bid > 0)
            {
                engine.Apply(TestData.Trade(t++, price, bid, BookSide.Ask, $"sb{start}-{offset}"));
            }

            if (ask > 0)
            {
                engine.Apply(TestData.Trade(t++, price, ask, BookSide.Bid, $"sa{start}-{offset}"));
            }
        }

        if (keepAlive)
        {
            engine.Apply(TestData.Depth(start + 59_000, BookSide.Bid, Px - 20, 5));
        }

        engine.Tick(closeAt ?? start + 60_000);
    }

    private static EngineOptions StackedOnly() => EngineOptions.Default with
    {
        OrderFlow = OrderFlowOptions.Default with
        {
            EnableIcebergs = false,
            EnableTrappedTraders = false,
            EnableCvdDivergence = false,
            EnableDeltaExhaustion = false,
            EnableSpoofs = false,
            EnableSweeps = false,
            EnableSinglePrints = false,
        },
    };

    private static InstrumentEngine NewEngine(EngineOptions options) => new(InstrumentCatalog.MES, options, TestData.Calendar());
}
