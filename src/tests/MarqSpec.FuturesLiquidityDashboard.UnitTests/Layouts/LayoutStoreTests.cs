using System.Reflection;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Layouts;

// reference: REQUIREMENTS.md FR-9; ARCHITECTURE.md D-18
public sealed partial class LayoutStoreTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    [Fact]
    public async Task Get_ShouldReportUnsaved_WhenTheUserHasNeverSaved()
    {
        var store = LayoutDisk.NewStore();

        var document = await store.GetAsync("viewer", CancellationToken.None);

        document.Saved.Should().BeFalse();
        document.Revision.Should().Be(0);
        document.Layout.Instrument.Should().Be("MES");
        document.Layout.HistoryMinutes.Should().Be(240);
    }

    [Fact]
    public async Task Save_ShouldIncrementTheRevision_WhenTheExpectedRevisionMatches()
    {
        var store = LayoutDisk.NewStore();

        var first = await store.SaveAsync("viewer", new LayoutSettings { Instrument = "MGC" }, 0, CancellationToken.None);
        var second = await store.SaveAsync("viewer", new LayoutSettings { Instrument = "MCL", HistoryMinutes = 60 }, 1, CancellationToken.None);

        first.Applied.Should().BeTrue();
        first.Document.Saved.Should().BeTrue();
        first.Document.Revision.Should().Be(1);
        first.Document.Layout.Instrument.Should().Be("MGC");
        second.Applied.Should().BeTrue();
        second.Document.Revision.Should().Be(2);
        second.Document.Layout.Instrument.Should().Be("MCL");
        second.Document.Layout.HistoryMinutes.Should().Be(60);
        (await store.GetAsync("viewer", CancellationToken.None)).Revision.Should().Be(2);
    }

    [Fact]
    public async Task Save_ShouldKeepTheRipsPreset_WhenValueAreaIsHidden()
    {
        var layout = new LayoutSettings
        {
            Preset = "rips",
            EmphasizeNodes = true,
            HideValueArea = true,
            ShowVolumeDots = true,
            ShowCandles = false,
            HeatDim = 0.25,
            HeatAutoContrast = true,
        };

        var saved = await LayoutDisk.NewStore().SaveAsync("viewer", layout, 0, CancellationToken.None);

        saved.Applied.Should().BeTrue();
        saved.Document.Layout.Preset.Should().Be("rips");
        saved.Document.Layout.EmphasizeNodes.Should().BeTrue();
        saved.Document.Layout.HideValueArea.Should().BeTrue();
        saved.Document.Layout.ShowCandles.Should().BeFalse();
        saved.Document.Layout.HeatDim.Should().Be(0.25);
        layout.Validate().Should().BeEmpty();
    }

    [Fact]
    public void Validate_ShouldRejectTheIndicatorPane_WhenItIsNotOneOfTheDockTabs()
    {
        new LayoutSettings { IndicatorPane = "volume" }.Validate().Should().BeEmpty();
        new LayoutSettings { IndicatorPane = "rsi14" }.Validate().Should().BeEmpty();
        new LayoutSettings { IndicatorPane = "tpo" }.Validate().Should().BeEmpty();
        new LayoutSettings { IndicatorPane = "volumes" }.Validate()
            .Should().Contain(error => error.Contains("IndicatorPane"));
        new LayoutSettings { IndicatorPane = "Volume" }.Validate()
            .Should().Contain(error => error.Contains("IndicatorPane"));
        new LayoutSettings { IndicatorPane = "price" }.Validate()
            .Should().Contain(error => error.Contains("IndicatorPane"));
        new LayoutSettings { IndicatorPane = "" }.Validate()
            .Should().Contain(error => error.Contains("IndicatorPane"));
        new LayoutSettings { IndicatorPane = null! }.Validate()
            .Should().Contain(error => error.Contains("IndicatorPane"));
    }

    [Fact]
    public async Task Save_ShouldKeepTheIndicatorPane_WhenTheTabIsOneOfTheDock()
    {
        var saved = await LayoutDisk.NewStore().SaveAsync("viewer", new LayoutSettings { IndicatorPane = "macd" }, 0, CancellationToken.None);

        saved.Applied.Should().BeTrue();
        saved.Document.Layout.IndicatorPane.Should().Be("macd");
        new LayoutSettings().IndicatorPane.Should().Be("volume");
        new LayoutSettings().IndicatorPaneSpecified.Should().BeFalse();
    }

    [Fact]
    public void PreservingStoredIndicatorPane_ShouldKeepTheStoredTab_WhenTheJsonOmitsTheField()
    {
        var omitted = JsonSerializer.Deserialize<LayoutSettings>("""{"instrument":"MGC","historyMinutes":30}""", Json);

        omitted.Should().NotBeNull();
        omitted!.IndicatorPaneSpecified.Should().BeFalse();
        omitted.IndicatorPane.Should().Be("volume");
        var kept = omitted.PreservingStoredIndicatorPane(new LayoutSettings { IndicatorPane = "cvd" });
        kept.IndicatorPane.Should().Be("cvd");
        kept.IndicatorPaneSpecified.Should().BeTrue();
        kept.Instrument.Should().Be("MGC");
        kept.HistoryMinutes.Should().Be(30);

        var explicitVolume = JsonSerializer.Deserialize<LayoutSettings>("""{"indicatorPane":"volume"}""", Json);
        explicitVolume!.IndicatorPaneSpecified.Should().BeTrue();
        explicitVolume.PreservingStoredIndicatorPane(new LayoutSettings { IndicatorPane = "cvd" }).IndicatorPane.Should().Be("volume");

        var explicitTab = JsonSerializer.Deserialize<LayoutSettings>("""{"indicatorPane":"tpo"}""", Json);
        explicitTab!.PreservingStoredIndicatorPane(new LayoutSettings { IndicatorPane = "cvd" }).IndicatorPane.Should().Be("tpo");
    }

    [Fact]
    public void IndicatorPane_ShouldReadAsVolume_WhenAnOlderClientSendsTheRetiredFootprintTab()
    {
        var older = JsonSerializer.Deserialize<LayoutSettings>("""{"indicatorPane":"footprint"}""", Json);

        older.Should().NotBeNull();
        older!.IndicatorPane.Should().Be("volume", "the footprint is Detail's main chart now, and the dock's first tab is Volume");
        older.IndicatorPaneSpecified.Should().BeTrue();
        older.Validate().Should().BeEmpty();
        older.PreservingStoredIndicatorPane(new LayoutSettings { IndicatorPane = "cvd" }).IndicatorPane.Should().Be("volume");
        new LayoutSettings { IndicatorPane = "cvd" }.IndicatorPane.Should().Be("cvd");
        using var served = JsonDocument.Parse(JsonSerializer.Serialize(older, Json));
        served.RootElement.GetProperty("indicatorPane").GetString().Should().Be("volume");
    }

    [Fact]
    public void Validate_ShouldRejectTheRangeZoneTimeframe_WhenItIsNot900Or300OrOff()
    {
        new LayoutSettings { RangeZoneTimeframe = "900" }.Validate().Should().BeEmpty();
        new LayoutSettings { RangeZoneTimeframe = "300" }.Validate().Should().BeEmpty();
        new LayoutSettings { RangeZoneTimeframe = "off" }.Validate().Should().BeEmpty();
        foreach (var bad in new[] { "60", "Off", "900 ", "", "1800" })
        {
            new LayoutSettings { RangeZoneTimeframe = bad }.Validate()
                .Should().Contain(error => error.Contains("RangeZoneTimeframe"), $"'{bad}' is not a range-zone timeframe");
        }

        new LayoutSettings { RangeZoneTimeframe = null! }.Validate()
            .Should().Contain(error => error.Contains("RangeZoneTimeframe"));
    }

    [Fact]
    public void PreservingStoredOmissions_ShouldKeepTheRangeZoneTimeframe_WhenTheJsonOmitsTheField()
    {
        new LayoutSettings().RangeZoneTimeframe.Should().Be("300", "five-minute bars drive the zones by default, so they show within the replayed history");
        using var fresh = JsonDocument.Parse(JsonSerializer.Serialize(new LayoutSettings(), Json));
        fresh.RootElement.GetProperty("rangeZoneTimeframe").GetString().Should().Be("300");
        var stored = new LayoutSettings { RangeZoneTimeframe = "off" };

        var omitted = JsonSerializer.Deserialize<LayoutSettings>("""{"instrument":"MGC"}""", Json);
        omitted!.PreservingStoredOmissions(stored).RangeZoneTimeframe.Should().Be("off", "an older client that omits the field must not reset it");

        var explicitDefault = JsonSerializer.Deserialize<LayoutSettings>("""{"rangeZoneTimeframe":"300"}""", Json);
        explicitDefault!.PreservingStoredOmissions(stored).RangeZoneTimeframe.Should().Be("300", "an explicit default replaces the stored value");
    }

    [Fact]
    public void Validate_ShouldAcceptTheRangeZonesLayer_WhenTheLayersToggleIsSaved()
    {
        new LayoutSettings { Panes = new() { ["range-zones"] = false } }.Validate().Should().BeEmpty();
        new LayoutSettings { Panes = new() { ["range-zone"] = false } }.Validate()
            .Should().Contain(error => error.Contains("range-zone"));
    }

    [Fact]
    public void Validate_ShouldRejectTheDetailChart_WhenItIsNeitherFootprintNorPrice()
    {
        new LayoutSettings { DetailChart = "footprint" }.Validate().Should().BeEmpty();
        new LayoutSettings { DetailChart = "price" }.Validate().Should().BeEmpty();
        new LayoutSettings { DetailChart = "candles" }.Validate()
            .Should().Contain(error => error.Contains("DetailChart"));
        new LayoutSettings { DetailChart = "Price" }.Validate()
            .Should().Contain(error => error.Contains("DetailChart"));
        new LayoutSettings { DetailChart = "footprints" }.Validate()
            .Should().Contain(error => error.Contains("DetailChart"));
        new LayoutSettings { DetailChart = "" }.Validate()
            .Should().Contain(error => error.Contains("DetailChart"));
        new LayoutSettings { DetailChart = null! }.Validate()
            .Should().Contain(error => error.Contains("DetailChart"));
    }

    [Fact]
    public async Task PreservingStoredOmissions_ShouldKeepTheDetailChart_WhenTheJsonOmitsTheField()
    {
        new LayoutSettings().DetailChart.Should().Be("footprint", "Detail opens on the footprint");
        using var fresh = JsonDocument.Parse(JsonSerializer.Serialize(new LayoutSettings(), Json));
        fresh.RootElement.GetProperty("detailChart").GetString().Should().Be("footprint");
        var stored = new LayoutSettings { DetailChart = "price" };

        var omitted = JsonSerializer.Deserialize<LayoutSettings>("""{"instrument":"MGC"}""", Json);
        omitted!.DetailChart.Should().Be("footprint");
        omitted.PreservingStoredOmissions(stored).DetailChart.Should().Be("price", "an older client that omits the field must not reset it");

        var explicitDefault = JsonSerializer.Deserialize<LayoutSettings>("""{"detailChart":"footprint"}""", Json);
        explicitDefault!.PreservingStoredOmissions(stored).DetailChart.Should().Be("footprint", "an explicit default replaces the stored value");

        var saved = await LayoutDisk.NewStore().SaveAsync("viewer", JsonSerializer.Deserialize<LayoutSettings>("""{"detailChart":"price"}""", Json)!, 0, CancellationToken.None);
        saved.Document.Layout.DetailChart.Should().Be("price");
    }

    [Fact]
    public async Task Save_ShouldRoundTripTheCollapsedDock_WhenTheLayoutCollapsesIt()
    {
        new LayoutSettings().IndicatorDockCollapsed.Should().BeFalse("the dock starts expanded");
        var collapsed = JsonSerializer.Deserialize<LayoutSettings>("""{"indicatorDockCollapsed":true}""", Json);
        collapsed.Should().NotBeNull();
        collapsed!.IndicatorDockCollapsed.Should().BeTrue();
        collapsed.Validate().Should().BeEmpty();

        var saved = await LayoutDisk.NewStore().SaveAsync("viewer", collapsed, 0, CancellationToken.None);

        saved.Applied.Should().BeTrue();
        saved.Document.Layout.IndicatorDockCollapsed.Should().BeTrue();
        using var served = JsonDocument.Parse(JsonSerializer.Serialize(saved.Document, Json));
        served.RootElement.GetProperty("layout").GetProperty("indicatorDockCollapsed").GetBoolean().Should().BeTrue();
        using var fresh = JsonDocument.Parse(JsonSerializer.Serialize(new LayoutSettings(), Json));
        fresh.RootElement.GetProperty("indicatorDockCollapsed").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public void PreservingStoredOmissions_ShouldKeepTheCollapsedDock_WhenTheJsonOmitsTheField()
    {
        var stored = new LayoutSettings { IndicatorDockCollapsed = true };

        var omitted = JsonSerializer.Deserialize<LayoutSettings>("""{"instrument":"MGC","indicatorPane":"cvd"}""", Json);
        var kept = omitted!.PreservingStoredOmissions(stored);
        kept.IndicatorDockCollapsed.Should().BeTrue("an older client that omits the field must not expand the dock");
        kept.IndicatorPane.Should().Be("cvd");

        var expanded = JsonSerializer.Deserialize<LayoutSettings>("""{"indicatorDockCollapsed":false}""", Json);
        expanded!.PreservingStoredOmissions(stored).IndicatorDockCollapsed.Should().BeFalse("an explicit false replaces the stored value");
        var collapse = JsonSerializer.Deserialize<LayoutSettings>("""{"indicatorDockCollapsed":true}""", Json);
        collapse!.PreservingStoredOmissions(new LayoutSettings()).IndicatorDockCollapsed.Should().BeTrue();
    }

    [Theory]
    [InlineData("null")]
    [InlineData("\"true\"")]
    [InlineData("1")]
    [InlineData("{}")]
    public void IndicatorDockCollapsed_ShouldRefuseTheWrite_WhenTheValueIsNotABoolean(string value)
    {
        var read = () => JsonSerializer.Deserialize<LayoutSettings>($$"""{"indicatorDockCollapsed":{{value}}}""", Json);

        read.Should().Throw<JsonException>();
    }

    [Fact]
    public async Task Save_ShouldRoundTripTheCollapsedSideSections_WhenTheLayoutCollapsesThem()
    {
        new LayoutSettings().SideSectionsCollapsed.Should().BeEmpty("every side-column section starts open");
        var collapsed = JsonSerializer.Deserialize<LayoutSettings>("""{"sideSectionsCollapsed":["ladder","layers"]}""", Json);
        collapsed.Should().NotBeNull();
        collapsed!.SideSectionsCollapsed.Should().Equal("ladder", "layers");
        collapsed.Validate().Should().BeEmpty();

        var saved = await LayoutDisk.NewStore().SaveAsync("viewer", collapsed, 0, CancellationToken.None);

        saved.Applied.Should().BeTrue();
        saved.Document.Layout.SideSectionsCollapsed.Should().Equal("ladder", "layers");
        using var served = JsonDocument.Parse(JsonSerializer.Serialize(saved.Document, Json));
        served.RootElement.GetProperty("layout").GetProperty("sideSectionsCollapsed").EnumerateArray()
            .Select(key => key.GetString()).Should().Equal("ladder", "layers");
        using var fresh = JsonDocument.Parse(JsonSerializer.Serialize(new LayoutSettings(), Json));
        fresh.RootElement.GetProperty("sideSectionsCollapsed").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public void PreservingStoredOmissions_ShouldKeepTheCollapsedSideSections_WhenTheJsonOmitsTheField()
    {
        var stored = new LayoutSettings { SideSectionsCollapsed = ["signals", "profile"] };

        var omitted = JsonSerializer.Deserialize<LayoutSettings>("""{"instrument":"MGC","indicatorDockCollapsed":true}""", Json);
        var kept = omitted!.PreservingStoredOmissions(stored);
        kept.SideSectionsCollapsed.Should().Equal(["signals", "profile"], "an older client that omits the field must not open every section");
        kept.IndicatorDockCollapsed.Should().BeTrue();

        var opened = JsonSerializer.Deserialize<LayoutSettings>("""{"sideSectionsCollapsed":[]}""", Json);
        opened!.PreservingStoredOmissions(stored).SideSectionsCollapsed.Should().BeEmpty("an explicit empty list replaces the stored one");
        var collapse = JsonSerializer.Deserialize<LayoutSettings>("""{"sideSectionsCollapsed":["levels"]}""", Json);
        collapse!.PreservingStoredOmissions(stored).SideSectionsCollapsed.Should().Equal("levels");
    }

    [Fact]
    public void Validate_ShouldAcceptEverySideSection_WhenTheKeysAreKnown()
    {
        string[] every = ["ladder", "liquidity", "signals", "levels", "profile", "layers"];

        LayoutSettings.KnownSideSections.Should().BeEquivalentTo(every);
        new LayoutSettings { SideSectionsCollapsed = [.. every] }.Validate().Should().BeEmpty();
    }

    [Theory]
    [InlineData("""["orders"]""")]
    [InlineData("""["ladder","overlay"]""")]
    [InlineData("""["Ladder"]""")]
    [InlineData("""[""]""")]
    [InlineData("""[null]""")]
    [InlineData("null")]
    public void Validate_ShouldRefuseTheSideSections_WhenAKeyIsUnknownOrTheListIsNull(string value)
    {
        var layout = JsonSerializer.Deserialize<LayoutSettings>($$"""{"sideSectionsCollapsed":{{value}}}""", Json);

        layout!.Validate().Should().Contain(error => error.Contains("SideSectionsCollapsed"));
    }

    [Theory]
    [InlineData("\"ladder\"")]
    [InlineData("true")]
    [InlineData("{}")]
    [InlineData("[1]")]
    public void SideSectionsCollapsed_ShouldRefuseTheWrite_WhenTheValueIsNotAListOfKeys(string value)
    {
        var read = () => JsonSerializer.Deserialize<LayoutSettings>($$"""{"sideSectionsCollapsed":{{value}}}""", Json);

        read.Should().Throw<JsonException>();
    }

    [Fact]
    public void PreservingStoredOmissions_ShouldRecordEveryLaterField_WhenThePropertyIsSet()
    {
        var layout = new LayoutSettings();
        var seen = 0;
        foreach (var property in typeof(LayoutSettings).GetProperties(BindingFlags.Instance | BindingFlags.Public))
        {
            if (!property.CanWrite || LayoutSettings.DefaultsWhenOmitted.Contains(property.Name))
            {
                continue;
            }

            property.SetValue(layout, property.GetValue(layout));
            layout.WasSpecified(property.Name).Should().BeTrue(
                "'{0}' must record that the write set it, or be named in DefaultsWhenOmitted", property.Name);
            seen++;
        }

        seen.Should().BeGreaterThan(0);
        LayoutSettings.DefaultsWhenOmitted.Should().BeEquivalentTo(
            ["Instrument", "SliceSeconds", "HistoryMinutes", "HeatContrast", "Panes", "Signals"]);
    }

    [Fact]
    public void Validate_ShouldRejectAnIcebergFloor_WhenItIsOutsideItsRange()
    {
        new LayoutSettings { IcebergMinStrengthPercent = 0, IcebergMinHiddenSize = 0 }.Validate().Should().BeEmpty();
        new LayoutSettings { IcebergMinStrengthPercent = 100, IcebergMinHiddenSize = 100_000 }.Validate().Should().BeEmpty();
        foreach (var bad in new[] { -1, 101 })
        {
            new LayoutSettings { IcebergMinStrengthPercent = bad }.Validate()
                .Should().Contain(error => error.Contains("IcebergMinStrengthPercent"), $"{bad} is not a percentage");
        }

        foreach (var bad in new[] { -1, 100_001 })
        {
            new LayoutSettings { IcebergMinHiddenSize = bad }.Validate()
                .Should().Contain(error => error.Contains("IcebergMinHiddenSize"), $"{bad} is outside 0–100,000 contracts");
        }
    }

    [Fact]
    public void PreservingStoredOmissions_ShouldKeepTheIcebergFloors_WhenTheJsonOmitsThem()
    {
        new LayoutSettings().IcebergMinStrengthPercent.Should().Be(0, "no floor hides nothing, as before the floors existed");
        new LayoutSettings().IcebergMinHiddenSize.Should().Be(0);
        using var fresh = JsonDocument.Parse(JsonSerializer.Serialize(new LayoutSettings(), Json));
        fresh.RootElement.GetProperty("icebergMinStrengthPercent").GetInt32().Should().Be(0);
        fresh.RootElement.GetProperty("icebergMinHiddenSize").GetInt32().Should().Be(0);
        var stored = new LayoutSettings { IcebergMinStrengthPercent = 60, IcebergMinHiddenSize = 25 };

        var omitted = JsonSerializer.Deserialize<LayoutSettings>("""{"instrument":"MGC"}""", Json)!.PreservingStoredOmissions(stored);
        (omitted.IcebergMinStrengthPercent, omitted.IcebergMinHiddenSize).Should().Be((60, 25), "an older client that omits the floors must not reset them");

        var explicitDefault = JsonSerializer.Deserialize<LayoutSettings>("""{"icebergMinStrengthPercent":0,"icebergMinHiddenSize":0}""", Json)!
            .PreservingStoredOmissions(stored);
        (explicitDefault.IcebergMinStrengthPercent, explicitDefault.IcebergMinHiddenSize).Should().Be((0, 0), "an explicit default replaces the stored floor");
    }

    [Fact]
    public void PreservingStoredOmissions_ShouldKeepEachLaterField_WhenTheJsonOmitsIt()
    {
        var stored = new LayoutSettings
        {
            Watchlist = ["MES"],
            ChartMinutes = 5,
            IndicatorMinutes = 15,
            HeatMode = "flow",
            Preset = "rips",
            ShowCandles = true,
            ShowVolumeDots = false,
            HeatDim = 0.4,
            HeatLowPercentile = 10,
            HeatHighPercentile = 90,
            HeatAutoContrast = false,
            DotMinQuantity = 4,
            EventDotSize = "large",
            CenterPrice = true,
            IndicatorPane = "cvd",
            DetailChart = "price",
            ShowPriceLine = false,
            HideValueArea = true,
            EmphasizeNodes = true,
        };
        var omitted = JsonSerializer.Deserialize<LayoutSettings>(
            """{"instrument":"MGC","sliceSeconds":5,"historyMinutes":45,"heatContrast":1.5,"panes":{"vwap":false},"signals":{"Spoof":false}}""",
            Json);

        omitted.Should().NotBeNull();
        omitted!.IndicatorPaneSpecified.Should().BeFalse();
        var kept = omitted.PreservingStoredOmissions(stored);

        kept.Instrument.Should().Be("MGC");
        kept.SliceSeconds.Should().Be(5);
        kept.HistoryMinutes.Should().Be(45);
        kept.HeatContrast.Should().Be(1.5);
        kept.Panes["vwap"].Should().BeFalse();
        kept.Signals["Spoof"].Should().BeFalse();
        kept.Watchlist.Should().Equal("MES");
        kept.ChartMinutes.Should().Be(5);
        kept.IndicatorMinutes.Should().Be(15);
        kept.HeatMode.Should().Be("flow");
        kept.Preset.Should().Be("rips");
        kept.ShowCandles.Should().BeTrue();
        kept.ShowVolumeDots.Should().BeFalse();
        kept.HeatDim.Should().Be(0.4);
        kept.HeatLowPercentile.Should().Be(10);
        kept.HeatHighPercentile.Should().Be(90);
        kept.HeatAutoContrast.Should().BeFalse();
        kept.DotMinQuantity.Should().Be(4);
        kept.EventDotSize.Should().Be("large");
        kept.CenterPrice.Should().BeTrue();
        kept.IndicatorPane.Should().Be("cvd");
        kept.IndicatorPaneSpecified.Should().BeTrue();
        kept.DetailChart.Should().Be("price");
        kept.ShowPriceLine.Should().BeFalse();
        kept.HideValueArea.Should().BeTrue();
        kept.EmphasizeNodes.Should().BeTrue();
        kept.Validate().Should().BeEmpty();
    }

    [Fact]
    public void PreservingStoredOmissions_ShouldReplaceTheStoredValue_WhenTheJsonSetsTheDefault()
    {
        var stored = new LayoutSettings
        {
            EventDotSize = "large",
            CenterPrice = true,
            ShowPriceLine = false,
            IndicatorPane = "tpo",
            DetailChart = "price",
            Preset = "rips",
            ShowVolumeDots = false,
            Instrument = "MGC",
        };
        var explicitDefaults = JsonSerializer.Deserialize<LayoutSettings>(
            """{"eventDotSize":"medium","centerPrice":false,"showPriceLine":true,"indicatorPane":"volume","detailChart":"footprint","preset":"standard","showVolumeDots":true}""",
            Json);

        explicitDefaults.Should().NotBeNull();
        var replaced = explicitDefaults!.PreservingStoredOmissions(stored);

        replaced.EventDotSize.Should().Be("medium");
        replaced.CenterPrice.Should().BeFalse();
        replaced.ShowPriceLine.Should().BeTrue();
        replaced.IndicatorPane.Should().Be("volume");
        replaced.DetailChart.Should().Be("footprint");
        replaced.Preset.Should().Be("standard");
        replaced.ShowVolumeDots.Should().BeTrue();
        replaced.Instrument.Should().Be("MES", "an omitted field from the first layout document still takes its default");
        replaced.Validate().Should().BeEmpty();

        var nullDot = JsonSerializer.Deserialize<LayoutSettings>("""{"eventDotSize":null}""", Json);
        nullDot!.EventDotSize.Should().BeNull();
        nullDot.PreservingStoredOmissions(stored).EventDotSize.Should().BeNull();
        nullDot.Validate().Should().Contain(error => error.Contains("EventDotSize"));
        var nullCenter = () => JsonSerializer.Deserialize<LayoutSettings>("""{"centerPrice":null}""", Json);
        nullCenter.Should().Throw<JsonException>();
    }

    [Fact]
    public void Validate_ShouldRejectThePreset_WhenThePercentileWindowIsInverted()
    {
        new LayoutSettings { HeatLowPercentile = 40, HeatHighPercentile = 60 }.Validate().Should().BeEmpty();
        new LayoutSettings { HeatLowPercentile = 40, HeatHighPercentile = 40 }.Validate()
            .Should().Contain(error => error.Contains("HeatHighPercentile"));
        new LayoutSettings { Preset = "bookmap" }.Validate().Should().Contain(error => error.Contains("Preset"));
        new LayoutSettings().EventDotSize.Should().Be("medium");
        new LayoutSettings { EventDotSize = "large" }.Validate().Should().BeEmpty();
        new LayoutSettings { EventDotSize = "huge" }.Validate().Should().Contain(error => error.Contains("EventDotSize"));
        new LayoutSettings { EventDotSize = null! }.Validate().Should().Contain(error => error.Contains("EventDotSize"));
        new LayoutSettings().ShowPriceLine.Should().BeTrue();
        new LayoutSettings { ShowPriceLine = false }.Validate().Should().BeEmpty();
        new LayoutSettings { ShowPriceLine = false }.ShowPriceLine.Should().BeFalse();
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(2)]
    [InlineData(60_000)]
    [InlineData(60_001)]
    [InlineData(1_700_000_000_000)]
    public async Task Save_ShouldKeepTheStoredLayout_WhenTheExpectedRevisionDoesNotMatch(long expected)
    {
        var store = LayoutDisk.NewStore();
        await store.SaveAsync("viewer", new LayoutSettings { Instrument = "MGC" }, 0, CancellationToken.None);

        var refused = await store.SaveAsync("viewer", new LayoutSettings { Instrument = "MCL" }, expected, CancellationToken.None);

        refused.Applied.Should().BeFalse();
        refused.Document.Saved.Should().BeTrue();
        refused.Document.Revision.Should().Be(1);
        refused.Document.Layout.Instrument.Should().Be("MGC");
        (await store.GetAsync("viewer", CancellationToken.None)).Layout.Instrument.Should().Be("MGC");
        (await store.GetAsync("viewer", CancellationToken.None)).Revision.Should().Be(1);
    }

    [Theory]
    [InlineData(-60_000)]
    [InlineData(60_000)]
    [InlineData(60_001)]
    public async Task Save_ShouldIgnoreAClockRevision_WhenNothingHasBeenSaved(long skewMs)
    {
        var store = LayoutDisk.NewStore();
        var wallClock = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + skewMs;

        var refused = await store.SaveAsync("viewer", new LayoutSettings { Instrument = "MCL" }, wallClock, CancellationToken.None);

        refused.Applied.Should().BeFalse();
        refused.Document.Saved.Should().BeFalse();
        refused.Document.Revision.Should().Be(0);
        (await store.GetAsync("viewer", CancellationToken.None)).Saved.Should().BeFalse();
        (await store.GetAsync("viewer", CancellationToken.None)).Layout.Instrument.Should().Be("MES");
    }

    [Fact]
    public async Task Save_ShouldApplyOnlyOne_WhenTwoSavesRaceOnTheSameRevision()
    {
        var store = LayoutDisk.NewStore();
        var results = await Task.WhenAll(
            Task.Run(() => store.SaveAsync("viewer", new LayoutSettings { Instrument = "MGC" }, 0, CancellationToken.None)),
            Task.Run(() => store.SaveAsync("viewer", new LayoutSettings { Instrument = "MCL" }, 0, CancellationToken.None)));

        results.Should().ContainSingle(result => result.Applied);
        results.Should().ContainSingle(result => !result.Applied);
        var applied = results.Single(result => result.Applied);
        (await store.GetAsync("viewer", CancellationToken.None)).Revision.Should().Be(1);
        (await store.GetAsync("viewer", CancellationToken.None)).Layout.Instrument.Should().Be(applied.Document.Layout.Instrument);
        results.Single(result => !result.Applied).Document.Layout.Instrument.Should().Be(applied.Document.Layout.Instrument);
    }

    [Fact]
    public async Task Save_ShouldKeepEachUserApart_WhenTwoViewersSave()
    {
        var store = LayoutDisk.NewStore();

        await store.SaveAsync("alice", new LayoutSettings { Instrument = "MGC" }, 0, CancellationToken.None);
        await store.SaveAsync("bob", new LayoutSettings { Instrument = "MCL" }, 0, CancellationToken.None);

        (await store.GetAsync("alice", CancellationToken.None)).Layout.Instrument.Should().Be("MGC");
        (await store.GetAsync("alice", CancellationToken.None)).Revision.Should().Be(1);
        (await store.GetAsync("bob", CancellationToken.None)).Layout.Instrument.Should().Be("MCL");
        (await store.GetAsync("bob", CancellationToken.None)).Revision.Should().Be(1);
        (await store.GetAsync("cara", CancellationToken.None)).Saved.Should().BeFalse();
        (await store.GetAsync("cara", CancellationToken.None)).Revision.Should().Be(0);
    }
}
