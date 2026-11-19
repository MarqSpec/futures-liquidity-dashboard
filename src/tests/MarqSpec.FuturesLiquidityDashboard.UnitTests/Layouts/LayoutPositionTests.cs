using System.Text.Json;
using System.Text.Json.Nodes;
using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Layouts;

// reference: REQUIREMENTS.md FR-72, FR-9, FR-6; ARCHITECTURE.md D-57
public sealed class LayoutPositionTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private const string Long = """
        {"side":"long","entryType":"limit","entryTicks":20000,"quantity":3,"stopTicks":19990,
         "targets":[{"priceTicks":20010,"quantity":1},{"priceTicks":20020,"quantity":2}],
         "contractId":"MESZ26","createdMs":1760000000000}
        """;

    private const string Short = """
        {"side":"short","entryType":"market","quantity":1,"stopTicks":1,"targets":[],"contractId":"MCLF27","createdMs":1760000000001}
        """;

    private const string ShortLimit = """
        {"side":"short","entryType":"limit","entryTicks":20000,"quantity":2,"stopTicks":20010,
         "targets":[{"priceTicks":19990,"quantity":2}],"contractId":"MESZ26","createdMs":1}
        """;

    private static LayoutSettings Layout(string positions) =>
        JsonSerializer.Deserialize<LayoutSettings>($$"""{"positions":{{positions}}}""", Json)!;

    private static LayoutSettings One(string position) => Layout($$"""{"MES":{{position}}}""");

    /// <summary>The valid long with one field replaced by <paramref name="value"/> (raw JSON).</summary>
    private static string With(string field, string value, string basis = Long)
    {
        var node = JsonNode.Parse(basis)!.AsObject();
        node[field] = JsonNode.Parse(value);
        return node.ToJsonString();
    }

    private static string Filled(string state, string fill, string exits)
    {
        var node = JsonNode.Parse(Long)!.AsObject();
        node["state"] = state;
        node["fill"] = JsonNode.Parse(fill);
        node["exits"] = JsonNode.Parse(exits);
        return node.ToJsonString();
    }

    [Fact]
    public void Positions_ShouldDefaultToNone_WhenTheLayoutIsNew()
    {
        new LayoutSettings().Positions.Should().BeEmpty();
        new LayoutSettings().Validate().Should().BeEmpty();
    }

    [Fact]
    public void Save_ShouldServeALongAndAShortAsJson_WhenBothAreValid()
    {
        var layout = Layout($$"""{"MES":{{Long}},"MCL":{{Short}}}""");
        layout.Validate().Should().BeEmpty();

        var saved = new LayoutStore().Save("viewer", layout, 0);

        saved.Applied.Should().BeTrue();
        using var served = JsonDocument.Parse(JsonSerializer.Serialize(saved.Document, Json));
        var positions = served.RootElement.GetProperty("layout").GetProperty("positions");
        positions.GetProperty("MES").GetProperty("side").GetString().Should().Be("long");
        positions.GetProperty("MES").GetProperty("targets").GetArrayLength().Should().Be(2);
        positions.GetProperty("MES").GetProperty("state").GetString().Should().Be("planned");
        positions.GetProperty("MCL").GetProperty("entryType").GetString().Should().Be("market");
    }

    [Fact]
    public void PreservingStoredOmissions_ShouldKeepThePositions_WhenTheWriteOmitsThem()
    {
        var stored = Layout($$"""{"MES":{{Long}}}""");
        var omitted = JsonSerializer.Deserialize<LayoutSettings>("""{"instrument":"MGC"}""", Json)!;

        var kept = omitted.PreservingStoredOmissions(stored);

        kept.Positions.Should().ContainKey("MES");
        kept.Positions["MES"].Quantity.Should().Be(3);
        kept.Positions.Should().NotBeSameAs(stored.Positions, "the copy must not alias the stored map");
        JsonSerializer.Deserialize<LayoutSettings>("""{"positions":{}}""", Json)!
            .PreservingStoredOmissions(stored).Positions.Should().BeEmpty("an explicit empty map clears them");
    }

    [Fact]
    public void WithActivePositions_ShouldDropAPosition_WhenItsContractIsNotTheRootsActiveOne()
    {
        var layout = Layout($$"""{"MES":{{Long}},"MCL":{{Short}},"MGC":{{With("contractId", "\"MGCG27\"")}}}""");
        var document = new LayoutDocument { Saved = true, Revision = 4, Layout = layout };
        static string? Active(string root) => root switch { "MES" => "MESZ26", "MCL" => "MCLH27", _ => null };

        var read = document.WithActivePositions(Active);

        read.Layout.Positions.Keys.Should().Equal("MES");
        read.Revision.Should().Be(4);
        document.Layout.Positions.Should().HaveCount(3, "a read does not rewrite the stored document");
    }

    private static LayoutDocument Stored(string contractId) =>
        new() { Saved = true, Revision = 3, Layout = Layout($$"""{"MES":{{With("contractId", $"\"{contractId}\"")}}}""") };

    [Fact]
    public void WithActivePositions_ShouldServeEveryStoredPosition_WhenTheContractsAreNotYetResolved()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var document = Stored("MESZ6");

        var read = document.WithActivePositions(registry, contractsResolved: false);

        read.Layout.Positions.Should().ContainKey("MES", "the registry still holds the catalog's placeholder contract, not the live one");
    }

    [Fact]
    public void WithActivePositions_ShouldSurviveASaveOfAnotherField_WhenTheContractsAreNotYetResolved()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES], EngineOptions.Default, TestData.Calendar());
        var store = new LayoutStore();
        store.Save("viewer", Stored("MESZ6").Layout, 0).Applied.Should().BeTrue();

        var read = store.Get("viewer").WithActivePositions(registry, contractsResolved: false);
        var other = JsonSerializer.Deserialize<LayoutSettings>("""{"historyMinutes":45}""", Json)!.PreservingStoredOmissions(read.Layout);
        store.Save("viewer", other, read.Revision);

        store.Get("viewer").Layout.Positions.Should().ContainKey("MES");
        store.Get("viewer").Layout.HistoryMinutes.Should().Be(45);
    }

    [Fact]
    public void WithActivePositions_ShouldDropAStalePosition_WhenTheContractsAreResolved()
    {
        var registry = new EngineRegistry([InstrumentRoot.MES, InstrumentRoot.MCL], EngineOptions.Default, TestData.Calendar());
        registry.Rebind(InstrumentCatalog.MES with { ContractId = "MESZ6" });

        Stored("MESZ6").WithActivePositions(registry, contractsResolved: true).Layout.Positions.Should().ContainKey("MES");
        Stored("MESH7").WithActivePositions(registry, contractsResolved: true).Layout.Positions.Should().BeEmpty("a roll leaves the old contract's position stale");
        var noEngine = Layout($$"""{"MGC":{{With("contractId", "\"MGCG7\"")}}}""");
        new LayoutDocument { Saved = true, Layout = noEngine }.WithActivePositions(registry, contractsResolved: true).Layout.Positions
            .Should().BeEmpty("a root with no engine has no active contract");
    }

    [Theory]
    [InlineData("stopTicks", "20001", "StopTicks")]
    [InlineData("stopTicks", "20000", "StopTicks")]
    [InlineData("stopTicks", "19990.5", "StopTicks")]
    [InlineData("entryTicks", "20000.5", "EntryTicks")]
    [InlineData("targets", """[{"priceTicks":19999,"quantity":1}]""", "Targets[0].PriceTicks")]
    [InlineData("targets", """[{"priceTicks":20000,"quantity":1}]""", "Targets[0].PriceTicks")]
    [InlineData("targets", """[{"priceTicks":20010.25,"quantity":1}]""", "Targets[0].PriceTicks")]
    [InlineData("targets", """[{"priceTicks":20010,"quantity":2},{"priceTicks":20020,"quantity":2}]""", "Targets")]
    [InlineData("targets", """[{"priceTicks":20010,"quantity":0}]""", "Targets[0].Quantity")]
    [InlineData("quantity", "0", "Quantity")]
    [InlineData("quantity", "101", "Quantity")]
    [InlineData("side", "\"flat\"", "Side")]
    [InlineData("entryType", "\"stop\"", "EntryType")]
    [InlineData("contractId", "\"\"", "ContractId")]
    [InlineData("state", "\"open\"", "State")]
    [InlineData("createdMs", "0", "CreatedMs")]
    [InlineData("contractId", "\"MESZ26MESZ26MESZ26MESZ26MESZ26MESZ26\"", "ContractId")]
    [InlineData("targets", "null", "Targets")]
    [InlineData("side", "null", "Side")]
    [InlineData("entryType", "null", "EntryType")]
    public void Validate_ShouldNameTheField_WhenAPositionBreaksARule(string field, string value, string named)
    {
        var errors = One(With(field, value)).Validate();

        errors.Should().Contain(e => e.Contains("Positions[MES]." + named, StringComparison.Ordinal), string.Join(" | ", errors));
    }

    [Theory]
    [InlineData("entryTicks", "2e20", "EntryTicks")]
    [InlineData("entryTicks", "9e18", "EntryTicks")]
    [InlineData("stopTicks", "-9e18", "StopTicks")]
    [InlineData("entryTicks", "1000000001", "EntryTicks")]
    [InlineData("stopTicks", "-1000000001", "StopTicks")]
    [InlineData("targets", """[{"priceTicks":3e20,"quantity":1}]""", "Targets[0].PriceTicks")]
    public void Validate_ShouldNameTheFieldAsOutOfRange_WhenATickPriceIsBeyondOneBillion(string field, string value, string named)
    {
        var errors = One(With(field, value)).Validate();

        errors.Should().Contain(e => e.StartsWith($"Positions[MES].{named} is out of range", StringComparison.Ordinal), string.Join(" | ", errors));
    }

    [Fact]
    public void Validate_ShouldAcceptTickPrices_WhenTheyAreExactlyOneBillionEitherSideOfZero()
    {
        var position = """
            {"side":"long","entryType":"limit","entryTicks":0,"quantity":1,"stopTicks":-1000000000,
             "targets":[{"priceTicks":1000000000,"quantity":1}],"contractId":"MESZ26","createdMs":1}
            """;

        One(position).Validate().Should().BeEmpty("a futures price may be negative, and ±1,000,000,000 ticks is the bound");
    }

    [Fact]
    public void Validate_ShouldAcceptTheEdges_WhenQuantityIsOneAndOneHundred()
    {
        One(With("quantity", "1", With("targets", "[]"))).Validate().Should().BeEmpty();
        One(With("quantity", "100")).Validate().Should().BeEmpty();
    }

    [Fact]
    public void Validate_ShouldRefuseAFourthTarget_WhenThreeAreAlreadyPlaced()
    {
        const string three = """[{"priceTicks":20010,"quantity":1},{"priceTicks":20011,"quantity":1},{"priceTicks":20012,"quantity":1}]""";
        const string four = """[{"priceTicks":20010,"quantity":1},{"priceTicks":20011,"quantity":1},{"priceTicks":20012,"quantity":1},{"priceTicks":20013,"quantity":1}]""";
        var room = With("quantity", "10");

        One(With("targets", three, room)).Validate().Should().BeEmpty("three targets are allowed");
        One(With("targets", four, room)).Validate()
            .Should().Contain(e => e.Contains("Positions[MES].Targets", StringComparison.Ordinal) && e.Contains("three", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_ShouldAcceptTargetsThatSumToExactlyTheQuantity_AndRefuseOneMore()
    {
        One(With("targets", """[{"priceTicks":20010,"quantity":1},{"priceTicks":20020,"quantity":2}]""")).Validate().Should().BeEmpty();
        One(With("targets", """[{"priceTicks":20010,"quantity":1},{"priceTicks":20020,"quantity":3}]""")).Validate()
            .Should().Contain(e => e.Contains("Positions[MES].Targets", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_ShouldAcceptTheMirrorImage_WhenAShortHasItsStopAboveAndTargetsBelow()
    {
        One(ShortLimit).Validate().Should().BeEmpty();
        One(With("stopTicks", "19990", ShortLimit)).Validate()
            .Should().Contain(e => e.Contains("Positions[MES].StopTicks", StringComparison.Ordinal));
        One(With("stopTicks", "20000", ShortLimit)).Validate()
            .Should().Contain(e => e.Contains("Positions[MES].StopTicks", StringComparison.Ordinal));
        One(With("targets", """[{"priceTicks":20010,"quantity":1}]""", ShortLimit)).Validate()
            .Should().Contain(e => e.Contains("Positions[MES].Targets[0].PriceTicks", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_ShouldRequireTheEntryPrice_WhenTheEntryIsALimit()
    {
        var errors = One("""{"side":"long","entryType":"limit","quantity":1,"stopTicks":1,"contractId":"MESZ26","createdMs":1}""").Validate();

        errors.Should().Contain(e => e.Contains("Positions[MES].EntryTicks", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_ShouldRefuseTheKey_WhenItIsNotAProductRoot()
    {
        Layout($$"""{"mes!":{{Long}}}""").Validate()
            .Should().Contain(e => e.Contains("Positions", StringComparison.Ordinal) && e.Contains("mes!", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_ShouldRefuse_WhenAPositionOrTheMapIsNull()
    {
        Layout("""{"MES":null}""").Validate().Should().Contain(e => e.Contains("Positions[MES]", StringComparison.Ordinal));
        JsonSerializer.Deserialize<LayoutSettings>("""{"positions":null}""", Json)!.Validate()
            .Should().Contain(e => e.Contains("Positions", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_ShouldAcceptTheTrackingFields_WhenTheyAreConsistent()
    {
        var closed = Filled(
            "closed",
            """{"timeMs":1760000001000,"priceTicks":20000}""",
            """[{"timeMs":1760000002000,"priceTicks":20010,"quantity":1,"kind":"target"},{"timeMs":1760000003000,"priceTicks":19990,"quantity":2,"kind":"stop"}]""");

        One(closed).Validate().Should().BeEmpty();
    }

    [Theory]
    [InlineData("filled", "null", "[]", "Fill")]
    [InlineData("closed", "null", "[]", "Fill")]
    [InlineData("working", """{"timeMs":1,"priceTicks":20000}""", "[]", "Fill")]
    [InlineData("planned", """{"timeMs":1,"priceTicks":20000}""", "[]", "Fill")]
    [InlineData("filled", """{"timeMs":1,"priceTicks":20000.5}""", "[]", "Fill.PriceTicks")]
    [InlineData("filled", """{"timeMs":1,"priceTicks":20000}""", """[{"timeMs":2,"priceTicks":20010,"quantity":4,"kind":"target"}]""", "Exits")]
    [InlineData("filled", """{"timeMs":1,"priceTicks":20000}""", """[{"timeMs":2,"priceTicks":20010,"quantity":1,"kind":"hope"}]""", "Exits[0].Kind")]
    [InlineData("working", "null", """[{"timeMs":2,"priceTicks":20010,"quantity":1,"kind":"target"}]""", "Exits")]
    [InlineData("filled", """{"timeMs":0,"priceTicks":20000}""", "[]", "Fill.TimeMs")]
    [InlineData("filled", """{"timeMs":1,"priceTicks":20000}""", """[{"timeMs":2,"priceTicks":20010,"quantity":0,"kind":"target"}]""", "Exits[0].Quantity")]
    [InlineData("filled", """{"timeMs":1,"priceTicks":20000}""", """[{"timeMs":0,"priceTicks":20010,"quantity":1,"kind":"target"}]""", "Exits[0].TimeMs")]
    [InlineData("filled", """{"timeMs":1,"priceTicks":20000}""", """[{"timeMs":2,"priceTicks":20010.5,"quantity":1,"kind":"target"}]""", "Exits[0].PriceTicks")]
    [InlineData("filled", """{"timeMs":1,"priceTicks":20000}""", "null", "Exits")]
    public void Validate_ShouldNameTheField_WhenTheTrackingFieldsContradictTheState(string state, string fill, string exits, string named)
    {
        var errors = One(Filled(state, fill, exits)).Validate();

        errors.Should().Contain(e => e.Contains("Positions[MES]." + named, StringComparison.Ordinal), string.Join(" | ", errors));
    }

    [Theory]
    [InlineData("""{"timeMs":1,"priceTicks":20000,"riskTicks":10}""")]
    [InlineData("""{"timeMs":1,"priceTicks":20000,"riskTicks":1}""")]
    [InlineData("""{"timeMs":1,"priceTicks":20000,"riskTicks":1000000000}""")]
    [InlineData("""{"timeMs":1,"priceTicks":20000,"riskTicks":null}""")]
    [InlineData("""{"timeMs":1,"priceTicks":20000}""")]
    public void Validate_ShouldAcceptTheFillRiskBasis_WhenItIsPositiveWholeAndInRangeOrAbsent(string fill)
    {
        One(Filled("filled", fill, "[]")).Validate().Should().BeEmpty();
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("2.5")]
    [InlineData("1000000001")]
    public void Validate_ShouldNameTheRiskBasis_WhenItIsNotAPositiveWholeNumberInRange(string risk)
    {
        var errors = One(Filled("filled", $$"""{"timeMs":1,"priceTicks":20000,"riskTicks":{{risk}}}""", "[]")).Validate();

        errors.Should().Contain(e => e.Contains("Positions[MES].Fill.RiskTicks", StringComparison.Ordinal), string.Join(" | ", errors));
    }

    [Fact]
    public void Save_ShouldServeTheRiskBasisBack_WhenTheFillCarriesIt()
    {
        var layout = One(Filled("filled", """{"timeMs":1,"priceTicks":20000,"riskTicks":10}""", "[]"));

        var json = JsonSerializer.Serialize(layout, Json);

        JsonNode.Parse(json)!["positions"]!["MES"]!["fill"]!["riskTicks"]!.GetValue<decimal>().Should().Be(10m);
    }

    [Fact]
    public void Validate_ShouldRequireTargetsBeyondTheStop_WhenAMarketEntryHasNoPrice()
    {
        const string marketLong = """{"side":"long","entryType":"market","quantity":2,"stopTicks":20010,"targets":[{"priceTicks":20020,"quantity":1}],"contractId":"MESZ26","createdMs":1}""";
        One(marketLong).Validate().Should().BeEmpty();
        One(With("targets", """[{"priceTicks":19990,"quantity":1}]""", marketLong)).Validate()
            .Should().Contain(e => e.Contains("Positions[MES].Targets[0].PriceTicks", StringComparison.Ordinal));
        One(With("targets", """[{"priceTicks":20010,"quantity":1}]""", marketLong)).Validate()
            .Should().Contain(e => e.Contains("Positions[MES].Targets[0].PriceTicks", StringComparison.Ordinal));
        var marketShort = marketLong.Replace("\"long\"", "\"short\"", StringComparison.Ordinal);
        One(With("targets", """[{"priceTicks":20000,"quantity":1}]""", marketShort)).Validate().Should().BeEmpty();
        One(marketShort).Validate().Should().Contain(e => e.Contains("Positions[MES].Targets[0].PriceTicks", StringComparison.Ordinal));
    }
}
