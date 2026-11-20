using MarqSpec.FuturesLiquidityDashboard.Core.Book;
using MarqSpec.FuturesLiquidityDashboard.Core.Liquidity;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Liquidity;

// reference: REQUIREMENTS.md NFR-4 (added / pulled / filled liquidity flow)
public sealed class LiquidityFlowTrackerTests
{
    private static readonly long T0 = TestData.EpochMs;
    private static readonly System.Text.Json.JsonSerializerOptions Wire = new(System.Text.Json.JsonSerializerDefaults.Web);

    [Fact]
    public void OnLevelChange_ShouldRecordAnIncreaseAsAdded_WhenRestingSizeGrows()
    {
        var tracker = new LiquidityFlowTracker();

        tracker.OnLevelChange(T0, new LevelChange(BookSide.Bid, 999, 10, 25));

        tracker.Totals(T0, 10_000).BidAdded.Should().Be(15);
    }

    [Fact]
    public void OnLevelChange_ShouldSplitADecreaseIntoFilledAndPulled_WhenARecentPrintMatchesPartOfIt()
    {
        var tracker = new LiquidityFlowTracker();
        tracker.OnTrade(T0, TestData.Trade(T0, 1000, 4, BookSide.Bid, "f1"));

        tracker.OnLevelChange(T0 + 100, new LevelChange(BookSide.Ask, 1000, 10, 0));

        var totals = tracker.Totals(T0 + 100, 10_000);
        (totals.AskFilled, totals.AskPulled, totals.NetAsk).Should().Be((4L, 6L, -10L));
    }

    [Fact]
    public void OnLevelChange_ShouldRecordTheWholeDecreaseAsPulled_WhenThePrintIsOlderThanTheMatchWindow()
    {
        var tracker = new LiquidityFlowTracker();
        tracker.OnTrade(T0, TestData.Trade(T0, 1000, 4, BookSide.Bid, "f1"));

        tracker.OnLevelChange(T0 + 2_001, new LevelChange(BookSide.Ask, 1000, 10, 0));

        var totals = tracker.Totals(T0 + 2_001, 10_000);
        (totals.AskFilled, totals.AskPulled).Should().Be((0L, 10L));
    }

    [Fact]
    public void Totals_ShouldCountOnlyFlowsInsideTheWindow_WhenOlderFlowsExist()
    {
        var tracker = new LiquidityFlowTracker();
        tracker.OnLevelChange(T0, new LevelChange(BookSide.Bid, 999, 0, 5));
        tracker.OnLevelChange(T0 + 9_000, new LevelChange(BookSide.Bid, 998, 0, 7));

        tracker.Totals(T0 + 10_000, 10_000).BidAdded.Should().Be(7);
    }

    [Fact]
    public void Reset_ShouldForgetPendingFills_WhenTheBookIsRebuilt()
    {
        var tracker = new LiquidityFlowTracker();
        tracker.OnTrade(T0, TestData.Trade(T0, 1000, 4, BookSide.Bid, "f1"));

        tracker.Reset();
        tracker.OnLevelChange(T0 + 100, new LevelChange(BookSide.Ask, 1000, 10, 6));

        tracker.Totals(T0 + 100, 10_000).AskPulled.Should().Be(4);
    }

    [Fact]
    public void NetFlow_ShouldBeAddedMinusPulledPerSide_WhenAllThreeKindsAreRecorded()
    {
        var totals = new FlowTotals(BidAdded: 100, BidPulled: 30, BidFilled: 20, AskAdded: 10, AskPulled: 45, AskFilled: 5);

        (totals.NetFlowBid, totals.NetFlowAsk).Should().Be((70L, -35L));
    }

    [Fact]
    public void NetFlow_ShouldIgnoreFilled_WhenAFillIsTheOnlyChange()
    {
        var tracker = new LiquidityFlowTracker();
        tracker.OnTrade(T0, TestData.Trade(T0, 1000, 4, BookSide.Bid, "f1"));
        tracker.OnLevelChange(T0 + 100, new LevelChange(BookSide.Ask, 1000, 10, 6));

        var totals = tracker.Totals(T0 + 100, 10_000);

        (totals.AskFilled, totals.NetFlowAsk, totals.NetAsk).Should().Be((4L, 0L, -4L));
    }

    [Fact]
    public void NetFlow_ShouldBeSerialisedBesideTheFr38Net_WhenTheTotalsAreSent()
    {
        var json = System.Text.Json.JsonSerializer.Serialize(
            new FlowTotals(100, 30, 20, 10, 45, 5), Wire);

        json.Should().Contain("\"netFlowBid\":70").And.Contain("\"netFlowAsk\":-35").And.Contain("\"netBid\":50").And.Contain("\"netAsk\":-40");
    }
}
