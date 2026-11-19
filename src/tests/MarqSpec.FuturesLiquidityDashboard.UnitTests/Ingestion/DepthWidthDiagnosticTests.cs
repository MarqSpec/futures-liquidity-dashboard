using System.Diagnostics.Metrics;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

public sealed class DepthWidthDiagnosticTests
{
    private static readonly InstrumentRoot Mes = InstrumentRoot.MES;

    [Fact]
    public void Report_ShouldEchoConfiguredCaps_WhenNoDepthHasArrived()
    {
        using var diagnostic = Create(out _, out _);

        var report = diagnostic.Report();

        report.LevelsPerSide.Should().Be(10);
        report.LadderLevels.Should().Be(20);
        report.MaxPricesPerSide.Should().Be(DepthWidthDiagnostic.MaxPricesPerSide);
        report.Instruments.Should().BeEmpty();
    }

    [Fact]
    public void Defaults_ShouldBeFiftyAndForty_WhenTheDiagnosticIsAdded()
    {
        new ProjectXFeedOptions().LevelsPerSide.Should().Be(50);
        EngineOptions.Default.LadderLevels.Should().Be(40);
    }

    [Fact]
    public void AddMarketData_ShouldKeepTheDepthDefaults_WhenTheSettingsAreUnset()
    {
        var report = Resolve(new Dictionary<string, string?> { ["Feed:Provider"] = "Synthetic" });

        report.LevelsPerSide.Should().Be(50);
        report.LadderLevels.Should().Be(40);
        report.Instruments.Should().BeEmpty();
    }

    [Fact]
    public void AddMarketData_ShouldExposeTheConfiguredCaps_WhenTheDiagnosticIsResolved()
    {
        var report = Resolve(new Dictionary<string, string?>
        {
            ["Feed:Provider"] = "Synthetic",
            ["Feed:ProjectX:LevelsPerSide"] = "20",
            ["Engine:LadderLevels"] = "20",
        });

        report.LevelsPerSide.Should().Be(20);
        report.LadderLevels.Should().Be(20);
    }

    [Fact]
    public void Note_ShouldCountTheBurst_WhenSeveralPricesArriveAtOneTimestamp()
    {
        using var diagnostic = Create(out _, out _);

        for (var price = 1; price <= 10; price++)
        {
            diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: 0);
        }

        for (var price = 100; price <= 111; price++)
        {
            diagnostic.Note(Mes, BookSide.Ask, price, present: true, nowMs: 0);
        }

        var row = diagnostic.Report().Instruments.Should().ContainSingle().Subject;
        row.Instrument.Should().Be("MES");
        row.CurrentBidLevels.Should().Be(10);
        row.CurrentAskLevels.Should().Be(12);
        row.MaxBidLevels.Should().Be(10);
        row.MaxAskLevels.Should().Be(12);
        row.TypicalBidLevels.Should().Be(10, "a burst at one timestamp is one sample of the book after the burst, not the first price");
        row.TypicalAskLevels.Should().Be(12);
        row.Samples.Should().Be(1);
        row.Capped.Should().BeFalse();
    }

    [Fact]
    public void Note_ShouldKeepTheHighWaterMark_WhenAWiderBookIsNotYetTheTypicalSample()
    {
        using var diagnostic = Create(out _, out _);
        for (var price = 1; price <= 10; price++)
        {
            diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: 0);
        }

        for (var price = 11; price <= 15; price++)
        {
            diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: 100);
        }

        var row = diagnostic.Report().Instruments.Should().ContainSingle().Subject;
        row.MaxBidLevels.Should().Be(15);
        row.CurrentBidLevels.Should().Be(15);
        row.TypicalBidLevels.Should().Be(10, "the extra prices arrived inside the same sample second");
        row.Samples.Should().Be(1);
    }

    [Fact]
    public void Note_ShouldReportTheLowerMedian_WhenTheBookChangesBetweenSeconds()
    {
        using var diagnostic = Create(out _, out _);
        for (var price = 1; price <= 4; price++)
        {
            diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: 0);
        }

        for (var price = 5; price <= 10; price++)
        {
            diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: 1_000);
        }

        diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: 2_000);

        var row = diagnostic.Report().Instruments.Should().ContainSingle().Subject;
        row.Samples.Should().Be(3);
        row.TypicalBidLevels.Should().Be(10, "samples are 4, 10 and 10; the lower median is the middle one");
        row.MaxBidLevels.Should().Be(10);
    }

    [Fact]
    public void Note_ShouldReportTheRecentMedian_WhenOlderSamplesLeaveTheRing()
    {
        using var diagnostic = Create(out _, out _);
        const int ring = DepthWidthDiagnostic.SampleRingCapacity;
        for (var i = 0; i < ring; i++)
        {
            diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: i * DepthWidthDiagnostic.SampleIntervalMs);
        }

        for (var price = 2; price <= 20; price++)
        {
            diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: ring * DepthWidthDiagnostic.SampleIntervalMs);
        }

        for (var i = 0; i < ring; i++)
        {
            diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: (ring + i) * DepthWidthDiagnostic.SampleIntervalMs);
        }

        var row = diagnostic.Report().Instruments.Should().ContainSingle().Subject;
        row.TypicalBidLevels.Should().Be(20);
        row.MaxBidLevels.Should().Be(20);
        row.Samples.Should().BeGreaterThan(ring);
    }

    [Fact]
    public void Note_ShouldDropAPrice_WhenTheGatewayRemovesIt()
    {
        using var diagnostic = Create(out _, out _);
        diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: 0);
        diagnostic.Note(Mes, BookSide.Bid, 2, present: true, nowMs: 0);

        diagnostic.Note(Mes, BookSide.Bid, 2, present: false, nowMs: 0);

        var row = diagnostic.Report().Instruments.Should().ContainSingle().Subject;
        row.CurrentBidLevels.Should().Be(1);
        row.MaxBidLevels.Should().Be(2);
        row.TypicalBidLevels.Should().Be(1, "the removal is the same timestamp, so the sample is the book after it");
    }

    [Fact]
    public void ClearBook_ShouldZeroTheCurrentBook_WhenTheGatewayResets_AndKeepTheHighWaterMark()
    {
        using var diagnostic = Create(out _, out _);
        diagnostic.Note(Mes, BookSide.Ask, 5, present: true, nowMs: 0);
        diagnostic.Note(Mes, BookSide.Ask, 6, present: true, nowMs: 0);

        diagnostic.ClearBook(Mes);

        var row = diagnostic.Report().Instruments.Should().ContainSingle().Subject;
        row.CurrentAskLevels.Should().Be(0);
        row.CurrentBidLevels.Should().Be(0);
        row.MaxAskLevels.Should().Be(2);
        row.Samples.Should().Be(1);
        row.TypicalAskLevels.Should().Be(2);
    }

    [Fact]
    public void Note_ShouldStopStoringPrices_WhenASideReachesTheCap()
    {
        using var diagnostic = Create(out _, out _);
        for (var price = 1; price <= DepthWidthDiagnostic.MaxPricesPerSide + 1; price++)
        {
            diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: 0);
        }

        var row = diagnostic.Report().Instruments.Should().ContainSingle().Subject;
        row.CurrentBidLevels.Should().Be(DepthWidthDiagnostic.MaxPricesPerSide);
        row.MaxBidLevels.Should().Be(DepthWidthDiagnostic.MaxPricesPerSide);
        row.Capped.Should().BeTrue();
    }

    [Fact]
    public void Note_ShouldKeepInstrumentsApart_WhenTwoRootsUpdate()
    {
        using var diagnostic = Create(out _, out _);
        diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: 0);
        diagnostic.Note(InstrumentRoot.MCL, BookSide.Ask, 9, present: true, nowMs: 0);
        diagnostic.Note(InstrumentRoot.MCL, BookSide.Ask, 10, present: true, nowMs: 0);

        var rows = diagnostic.Report().Instruments;
        rows.Select(r => r.Instrument).Should().Equal("MCL", "MES");
        rows[0].CurrentAskLevels.Should().Be(2);
        rows[0].CurrentBidLevels.Should().Be(0);
        rows[1].CurrentBidLevels.Should().Be(1);
        rows[1].CurrentAskLevels.Should().Be(0);
    }

    [Fact]
    public void Note_ShouldLogCountsWithoutPrices_WhenASecondOfDepthHasPassed()
    {
        const long price = 424_242;
        var logger = new CollectingLogger();
        using var diagnostic = Create(out _, out _, logger);

        diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: 0);
        logger.Lines.Should().BeEmpty("the first sample can still be a partial burst");

        diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: DepthWidthDiagnostic.SampleIntervalMs);

        var line = logger.Lines.Should().ContainSingle().Subject;
        line.Should().Contain("MES");
        line.Should().Contain("LevelsPerSide 10");
        line.Should().Contain("LadderLevels 20");
        line.Should().NotContain(price.ToString(System.Globalization.CultureInfo.InvariantCulture));
        line.Should().NotContain("424242");
    }

    [Fact]
    public void Note_ShouldLogOnceAMinute_WhenDepthKeepsArriving()
    {
        var logger = new CollectingLogger();
        using var diagnostic = Create(out _, out _, logger);
        diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: 0);
        diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: 1_000);
        diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: 2_000);

        logger.Lines.Should().ContainSingle();

        diagnostic.Note(Mes, BookSide.Bid, 1, present: true, nowMs: 1_000 + DepthWidthDiagnostic.LogIntervalMs);

        logger.Lines.Should().HaveCount(2);
    }

    [Fact]
    public void Gauges_ShouldPublishConfiguredCapsAndReceivedWidth_WhenDepthHasBeenNoted()
    {
        using var diagnostic = Create(out var meters, out var provider);
        var before = Read(meters, diagnostic);
        before["fld.depth.levels_per_side"].Should().ContainSingle().Which.Value.Should().Be(10);
        before["fld.depth.ladder_levels"].Should().ContainSingle().Which.Value.Should().Be(20);
        before.Should().NotContainKey("fld.depth.received_bids_max");

        for (var price = 1; price <= 15; price++)
        {
            diagnostic.Note(Mes, BookSide.Bid, price, present: true, nowMs: 0);
        }

        diagnostic.Note(Mes, BookSide.Ask, 100, present: true, nowMs: 0);

        var after = Read(meters, diagnostic);
        after["fld.depth.received_bids_max"].Should().ContainSingle().Which.Should().Be((15L, "MES"));
        after["fld.depth.received_bids_typical"].Should().ContainSingle().Which.Should().Be((15L, "MES"));
        after["fld.depth.received_bids"].Should().ContainSingle().Which.Should().Be((15L, "MES"));
        after["fld.depth.received_asks"].Should().ContainSingle().Which.Should().Be((1L, "MES"));
        after["fld.depth.received_capped"].Should().ContainSingle().Which.Should().Be((0L, "MES"));
        provider.Dispose();
    }

    private static DepthWidthReport Resolve(Dictionary<string, string?> settings)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddMetrics();
        services.AddMarketData(config);
        using var provider = services.BuildServiceProvider();
        return provider.GetRequiredService<DepthWidthDiagnostic>().Report();
    }

    private static DepthWidthDiagnostic Create(out IMeterFactory meters, out ServiceProvider provider, ILogger<DepthWidthDiagnostic>? logger = null)
    {
        var services = new ServiceCollection();
        services.AddMetrics();
        provider = services.BuildServiceProvider();
        meters = provider.GetRequiredService<IMeterFactory>();
        return new DepthWidthDiagnostic(meters, logger ?? NullLogger<DepthWidthDiagnostic>.Instance, levelsPerSide: 10, ladderLevels: 20);
    }

    private static Dictionary<string, List<(long Value, string? Instrument)>> Read(IMeterFactory meters, DepthWidthDiagnostic diagnostic)
    {
        _ = diagnostic;
        var found = new Dictionary<string, List<(long Value, string? Instrument)>>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (ReferenceEquals(instrument.Meter.Scope, meters) && instrument.Name.StartsWith("fld.depth.", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, value, tags, _) =>
        {
            string? root = null;
            foreach (var tag in tags)
            {
                if (tag.Key == "instrument")
                {
                    root = tag.Value?.ToString();
                }
            }

            if (!found.TryGetValue(instrument.Name, out var list))
            {
                list = [];
                found[instrument.Name] = list;
            }

            list.Add((value, root));
        });
        listener.Start();
        listener.RecordObservableInstruments();
        return found;
    }

    private sealed class CollectingLogger : ILogger<DepthWidthDiagnostic>
    {
        public List<string> Lines { get; } = [];

        public IDisposable BeginScope<TState>(TState state)
            where TState : notnull
            => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Add(formatter(state, exception));

        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();

            public void Dispose()
            {
            }
        }
    }
}
