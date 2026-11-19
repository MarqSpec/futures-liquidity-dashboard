using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.OrderFlow;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Core.Sessions;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Replay;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Ingestion;

// reference: ARCHITECTURE.md D-11 (ingestion), D-12 (replay labelled REPLAY), D-15 (credentials fail fast)
public sealed class ReplayAndHostingTests
{
    [Fact]
    public async Task Replay_LoadAsync_ReadsJsonLinesInTimeOrder()
    {
        var path = Path.Combine(Path.GetTempPath(), $"replay-{Guid.NewGuid():N}.jsonl");
        try
        {
            var later = Trade(2_000, 2, "b");
            var earlier = Trade(1_000, 1, "a");
            await File.WriteAllLinesAsync(path,
            [
                JsonSerializer.Serialize<MarketEvent>(later, MarketEventJsonContext.Default.MarketEvent),
                string.Empty,
                JsonSerializer.Serialize<MarketEvent>(earlier, MarketEventJsonContext.Default.MarketEvent),
            ]);

            var events = await ReplayMarketFeed.LoadAsync(path, CancellationToken.None);

            events.Select(e => e.SourceTimeMs).Should().Equal(1_000, 2_000);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Replay_Rebase_RelabelsAsReplay_AndSuffixesTradeIdsAfterTheFirstPass()
    {
        var spec = InstrumentCatalog.MES;
        var status = new FeedStatusEvent
        {
            Root = InstrumentRoot.MES,
            ContractId = "old",
            SourceTimeMs = 1,
            ReceivedTimeMs = 1,
            Epoch = 9,
            Sequence = 1,
            Connected = true,
            Provenance = FeedProvenance.Live,
        };

        ((FeedStatusEvent)ReplayMarketFeed.Rebase(status, spec, 5_000, 1)).Provenance.Should().Be(FeedProvenance.Replay);
        var first = (TradeEvent)ReplayMarketFeed.Rebase(Trade(1, 1, "t1"), spec, 5_000, 1);
        var second = (TradeEvent)ReplayMarketFeed.Rebase(Trade(1, 1, "t1"), spec, 9_000, 2);
        first.TradeId.Should().Be("t1");
        second.TradeId.Should().Be("t1-L2");
        second.SourceTimeMs.Should().Be(9_000);
        second.Epoch.Should().Be(2);
        second.ContractId.Should().Be(spec.ContractId);
    }

    [Fact]
    public void HistoryWindow_ReachesBackToTheSessionOpen_OrTheMinimumHours_CappedAtADay()
    {
        var calendar = new ExchangeCalendar();
        var now = new DateTimeOffset(2026, 11, 10, 15, 0, 0, TimeSpan.Zero); // Tuesday 09:00 CT; session opened Monday 17:00 CT
        var (from, to) = IngestionService.HistoryWindow(now, 4, calendar);

        to.Should().Be(now.ToUnixTimeMilliseconds());
        from.Should().Be(calendar.SessionFor(now).Open.ToUnixTimeMilliseconds(), "the open (16 h ago) is further back than 4 h");

        var (from2, _) = IngestionService.HistoryWindow(now, 24, calendar);
        from2.Should().Be(now.AddHours(-24).ToUnixTimeMilliseconds());
    }

    [Fact]
    public void RequireProjectXCredentials_WithoutThem_FailsWithAClearMessage()
    {
        var empty = new ConfigurationBuilder().Build();
        var act = () => IngestionServiceCollectionExtensions.RequireProjectXCredentials(empty);
        act.Should().Throw<InvalidOperationException>().WithMessage("*PROJECTX_API_KEY*Synthetic*");

        var withKeys = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ProjectX:ApiKey"] = "synthetic-key",
            ["ProjectX:ApiSecret"] = "synthetic-secret",
        }).Build();
        IngestionServiceCollectionExtensions.RequireProjectXCredentials(withKeys);
    }

    [Fact]
    public void ReadInstruments_DefaultsToEveryCatalogProduct()
    {
        IngestionServiceCollectionExtensions.ReadInstruments(new ConfigurationBuilder().Build())
            .Should().Equal(InstrumentCatalog.All.Select(s => s.Root));
    }

    [Theory]
    [InlineData("*", true, 0)]
    [InlineData("NQ", false, 1)]
    public void ReadSelection_ReadsAllOrTheNamedRoots_LessTheExcluded(string listed, bool all, int named)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:Instruments:0"] = listed,
            ["Engine:ExcludeInstruments:0"] = "mes",
        }).Build();

        var selection = IngestionServiceCollectionExtensions.ReadSelection(config);

        selection.All.Should().Be(all);
        selection.Roots.Should().HaveCount(named);
        selection.Includes(InstrumentRoot.Parse("MES")).Should().BeFalse();
        selection.InitialSpecs().Should().NotContain(s => s.Root.Value == "MES");
    }

    [Fact]
    public void ReadSelection_RefusesAMalformedRoot()
    {
        var bad = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Engine:Instruments:0"] = "E-S" }).Build();

        var act = () => IngestionServiceCollectionExtensions.ReadSelection(bad);

        act.Should().Throw<InvalidOperationException>().WithMessage("*E-S*");
    }

    [Fact]
    public void AddMarketData_RefusesARootOutsideTheCatalog_WhenTheFeedCannotDiscoverIt()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Feed:Provider"] = "Synthetic",
            ["Engine:Instruments:0"] = "ZZZ",
        }).Build();

        var act = () => new ServiceCollection().AddMarketData(config);

        act.Should().Throw<InvalidOperationException>().WithMessage("*ZZZ*catalog*");
    }

    [Fact]
    public void ReadEngineOptions_ReplacesTheRegimeTimeframes_AndChecksTheThresholds()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:Regime:TimeframesSeconds:0"] = "60",
            ["Engine:Regime:TrendAdx"] = "30",
        }).Build();

        var options = IngestionServiceCollectionExtensions.ReadEngineOptions(config);

        options.Regime.TimeframesSeconds.Should().Equal(60);
        options.Regime.TrendAdx.Should().Be(30);
        Core.Regime.RegimeOptions.Default.TimeframesSeconds.Should().Equal(300, 900);

        var inverted = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Engine:Regime:RangeAdx"] = "40" }).Build();
        var act = () => IngestionServiceCollectionExtensions.ReadEngineOptions(inverted);
        act.Should().Throw<InvalidOperationException>().WithMessage("*RangeAdx*");
    }

    [Theory]
    [InlineData(4, false)]
    [InlineData(5, true)]
    [InlineData(50, true)]
    [InlineData(200, true)]
    [InlineData(201, false)]
    public void ProjectXFeedOptions_ShouldAcceptLevelsPerSide_OnlyFromFiveToTwoHundred(int levels, bool accepted)
    {
        var options = new ProjectXFeedOptions { LevelsPerSide = levels };
        var results = new List<ValidationResult>();

        var valid = Validator.TryValidateObject(options, new ValidationContext(options), results, validateAllProperties: true);

        valid.Should().Be(accepted);
        if (!accepted)
        {
            results.Should().Contain(r => r.MemberNames.Contains(nameof(ProjectXFeedOptions.LevelsPerSide)));
        }
    }

    [Fact]
    public void AddMarketData_ShouldRejectProjectXLevelsPerSide_WhenItIsAboveTwoHundred()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Feed:Provider"] = "Synthetic",
            ["Feed:ProjectX:LevelsPerSide"] = "201",
        }).Build();
        var services = new ServiceCollection();
        services.AddMarketData(config);
        using var provider = services.BuildServiceProvider();

        var act = () => provider.GetRequiredService<IOptions<FeedOptions>>().Value;

        act.Should().Throw<OptionsValidationException>().WithMessage("*Feed:ProjectX:LevelsPerSide*5*200*");
    }

    [Fact]
    public void ReadEngineOptions_ShouldDefaultLadderLevelsToForty_WhenUnset()
    {
        var config = new ConfigurationBuilder().Build();

        IngestionServiceCollectionExtensions.ReadEngineOptions(config).LadderLevels.Should().Be(40);
    }

    [Theory]
    [InlineData(5)]
    [InlineData(40)]
    [InlineData(200)]
    public void ReadEngineOptions_ShouldAcceptLadderLevels_WhenInsideFiveToTwoHundred(int levels)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:LadderLevels"] = levels.ToString(CultureInfo.InvariantCulture),
        }).Build();

        IngestionServiceCollectionExtensions.ReadEngineOptions(config).LadderLevels.Should().Be(levels);
    }

    [Theory]
    [InlineData(4)]
    [InlineData(201)]
    public void ReadEngineOptions_ShouldRejectLadderLevels_WhenOutsideFiveToTwoHundred(int levels)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:LadderLevels"] = levels.ToString(CultureInfo.InvariantCulture),
        }).Build();

        var act = () => IngestionServiceCollectionExtensions.ReadEngineOptions(config);

        act.Should().Throw<InvalidOperationException>().WithMessage("*Engine:LadderLevels*5*200*");
    }

    [Fact]
    public void ReadEngineOptions_BindsOrderFlowThresholds_WithoutTouchingTheDefaults()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:OrderFlow:ImbalanceRatio"] = "4",
            ["Engine:OrderFlow:EnableSpoofs"] = "false",
        }).Build();

        var options = IngestionServiceCollectionExtensions.ReadEngineOptions(config);

        options.OrderFlow.ImbalanceRatio.Should().Be(4);
        options.OrderFlow.EnableSpoofs.Should().BeFalse();
        options.OrderFlow.SignalHistoryCap.Should().Be(20_000);
        Core.OrderFlow.OrderFlowOptions.Default.ImbalanceRatio.Should().Be(3);
        Core.OrderFlow.OrderFlowOptions.Default.SignalHistoryCap.Should().Be(20_000);
    }

    [Fact]
    public void WarnRetiredSignalRetention_ShouldLogAWarning_WhenTheRetiredKeyIsSet()
    {
        var logger = A.Fake<ILogger>();
        A.CallTo(() => logger.IsEnabled(A<LogLevel>._)).Returns(true);
        var set = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:OrderFlow:SignalRetention"] = "100",
        }).Build();

        IngestionServiceCollectionExtensions.WarnRetiredSignalRetention(set, logger);

        RetiredSignalRetentionWarnings(logger).Should().Be(1);
        IngestionServiceCollectionExtensions.ReadEngineOptions(set).OrderFlow.SignalHistoryCap.Should().Be(20_000);
    }

    [Fact]
    public void WarnRetiredSignalRetention_ShouldStayQuiet_WhenTheRetiredKeyIsAbsent()
    {
        var logger = A.Fake<ILogger>();
        A.CallTo(() => logger.IsEnabled(A<LogLevel>._)).Returns(true);

        IngestionServiceCollectionExtensions.WarnRetiredSignalRetention(new ConfigurationBuilder().Build(), logger);

        RetiredSignalRetentionWarnings(logger).Should().Be(0);
    }

    private static int RetiredSignalRetentionWarnings(ILogger logger) =>
        Fake.GetCalls(logger).Count(call =>
            call.Method.Name == nameof(ILogger.Log)
            && call.GetArgument<LogLevel>(0) == LogLevel.Warning
            && call.GetArgument<EventId>(1).Name == "RetiredSignalRetention");

    [Fact]
    public void ReadEngineOptions_ShouldClampTheSignalHistoryCap_WhenItIsBelowOneOrAboveOneHundredThousand()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:OrderFlow:SignalHistoryCap"] = "0",
        }).Build();

        IngestionServiceCollectionExtensions.ReadEngineOptions(config).OrderFlow.SignalHistoryCap.Should().Be(1);

        var raised = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:OrderFlow:SignalHistoryCap"] = "500",
        }).Build();
        IngestionServiceCollectionExtensions.ReadEngineOptions(raised).OrderFlow.SignalHistoryCap.Should().Be(500);

        var typo = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Engine:OrderFlow:SignalHistoryCap"] = "200000000",
        }).Build();
        IngestionServiceCollectionExtensions.ReadEngineOptions(typo).OrderFlow.SignalHistoryCap.Should().Be(OrderFlowOptions.MaxSignalHistoryCap);
    }

    [Fact]
    public void ReadEngineOptions_ShouldKeepThePrintCap_WhenTheSectionOmitsIt()
    {
        var omitted = IngestionServiceCollectionExtensions.ReadEngineOptions(new ConfigurationBuilder().Build());
        var configured = IngestionServiceCollectionExtensions.ReadEngineOptions(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["Engine:PrintCapacity"] = "8" }).Build());

        omitted.PrintCapacity.Should().Be(4_096);
        configured.PrintCapacity.Should().Be(8);
    }

    private static TradeEvent Trade(long timeMs, long sequence, string id) => new()
    {
        Root = InstrumentRoot.MES,
        ContractId = "ESZ26",
        SourceTimeMs = timeMs,
        ReceivedTimeMs = timeMs,
        Epoch = 1,
        Sequence = sequence,
        PriceTicks = 27200,
        Quantity = 1,
        Aggressor = BookSide.Bid,
        TradeId = id,
    };
}
