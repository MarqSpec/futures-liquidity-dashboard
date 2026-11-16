using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Overlays;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Overlays;

// reference: REQUIREMENTS.md FR-8, ARCHITECTURE.md T-3
public sealed class OverlayStoreTests
{
    private const string Publisher = "synthetic-agent";
    private static readonly DateTimeOffset Now = TestData.Epoch;
    private readonly TimeProvider _time = A.Fake<TimeProvider>();

    public OverlayStoreTests() => A.CallTo(() => _time.GetUtcNow()).Returns(Now);

    [Fact]
    public void Publish_ShouldAcceptAndStoreTheOverlay_WhenTheRequestIsValid()
    {
        var store = new OverlayStore(_time);

        var result = store.Publish(InstrumentRoot.MES, Request(1), Publisher);

        result.Accepted.Should().BeTrue();
        result.Rejection.Should().Be(OverlayRejection.None);
        result.Overlay!.AvailableAt.Should().Be(Now);
        store.Current(InstrumentRoot.MES).Should().BeSameAs(result.Overlay);
    }

    [Fact]
    public void Publish_ShouldRejectNotThrow_WhenAListOrTextIsNull()
    {
        var store = new OverlayStore(_time);

        store.Publish(InstrumentRoot.MES, Request(1) with { Levels = null! }, Publisher).Rejection.Should().Be(OverlayRejection.InvalidLevel);
        store.Publish(InstrumentRoot.MES, Request(1) with { Rationale = null! }, Publisher).Rejection.Should().Be(OverlayRejection.InvalidLevel);
        store.Publish(InstrumentRoot.MES, Request(1) with { QualityFlags = null! }, Publisher).Rejection.Should().Be(OverlayRejection.InvalidLevel);
    }

    [Fact]
    public void Publish_ShouldRejectAsTooLarge_WhenThereAreTooManyQualityFlags()
    {
        var store = new OverlayStore(_time);
        var flags = Enumerable.Range(0, OverlayStore.MaxQualityFlags + 1).Select(i => $"flag-{i}").ToList();

        store.Publish(InstrumentRoot.MES, Request(1) with { QualityFlags = flags }, Publisher).Rejection.Should().Be(OverlayRejection.TooLarge);
    }

    [Fact]
    public void Publish_ShouldRaiseChangedOnce_WhenANewVersionIsAccepted()
    {
        var store = new OverlayStore(_time);
        var changes = new List<InstrumentRoot>();
        store.Changed += changes.Add;

        store.Publish(InstrumentRoot.MES, Request(1), Publisher);
        store.Publish(InstrumentRoot.MES, Request(1), Publisher);

        changes.Should().Equal(InstrumentRoot.MES);
    }

    [Fact]
    public void Publish_ShouldReturnTheCurrentOverlay_WhenTheSameVersionIsRepeated()
    {
        var store = new OverlayStore(_time);
        var first = store.Publish(InstrumentRoot.MES, Request(2), Publisher);

        var repeat = store.Publish(InstrumentRoot.MES, Request(2) with { Rationale = "different text" }, Publisher);

        repeat.Accepted.Should().BeTrue();
        repeat.Message.Should().Be("Version already current.");
        repeat.Overlay.Should().BeSameAs(first.Overlay);
    }

    [Fact]
    public void Publish_ShouldRejectAsStale_WhenTheVersionIsOlderThanTheCurrentOne()
    {
        var store = new OverlayStore(_time);
        store.Publish(InstrumentRoot.MES, Request(2), Publisher);

        var result = store.Publish(InstrumentRoot.MES, Request(1), Publisher);

        result.Rejection.Should().Be(OverlayRejection.StaleVersion);
        store.Current(InstrumentRoot.MES)!.Request.Version.Should().Be(2);
    }

    [Fact]
    public void Publish_ShouldReplaceTheOverlay_WhenTheVersionIsNewer()
    {
        var store = new OverlayStore(_time);
        store.Publish(InstrumentRoot.MES, Request(1), Publisher);

        store.Publish(InstrumentRoot.MES, Request(3), Publisher);

        store.Current(InstrumentRoot.MES)!.Request.Version.Should().Be(3);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-60)]
    public void Publish_ShouldRejectAsExpired_WhenItExpiresAtOrBeforeNow(int expiresInSeconds)
    {
        var store = new OverlayStore(_time);

        var result = store.Publish(InstrumentRoot.MES, Request(1) with { ExpiresAt = Now.AddSeconds(expiresInSeconds) }, Publisher);

        result.Rejection.Should().Be(OverlayRejection.Expired);
        store.Current(InstrumentRoot.MES).Should().BeNull();
    }

    [Fact]
    public void Publish_ShouldRejectTheWrongContract_WhenTheRequestNamesAnotherContract()
    {
        var store = new OverlayStore(_time);

        var result = store.Publish(InstrumentRoot.MES, Request(1) with { ContractId = "ESH27" }, Publisher);

        result.Rejection.Should().Be(OverlayRejection.WrongContract);
    }

    [Fact]
    public void Publish_ShouldCheckTheStreamedContract_WhenASpecResolverIsGiven()
    {
        var store = new OverlayStore(_time, _ => InstrumentCatalog.MES with { ContractId = "ESH27" });

        var stale = store.Publish(InstrumentRoot.MES, Request(1), Publisher);
        var current = store.Publish(InstrumentRoot.MES, Request(1) with { ContractId = "ESH27" }, Publisher);

        stale.Rejection.Should().Be(OverlayRejection.WrongContract);
        current.Accepted.Should().BeTrue();
    }

    [Theory]
    [InlineData("6000.10", "support")]
    [InlineData("0", "support")]
    [InlineData("-6000.25", "support")]
    [InlineData("6000.25", " ")]
    public void Publish_ShouldRejectAnInvalidLevel_WhenAPriceIsOffTheGridOrALabelIsBlank(string price, string label)
    {
        var store = new OverlayStore(_time);
        var level = new OverlayLevel { Price = decimal.Parse(price, System.Globalization.CultureInfo.InvariantCulture), Label = label };

        var result = store.Publish(InstrumentRoot.MES, Request(1) with { Levels = [level] }, Publisher);

        result.Rejection.Should().Be(OverlayRejection.InvalidLevel);
    }

    [Fact]
    public void Publish_ShouldRejectAnInvalidLevel_WhenALabelIsTooLong()
    {
        var store = new OverlayStore(_time);
        var level = new OverlayLevel { Price = 6000.25m, Label = new string('x', OverlayStore.MaxLabelLength + 1) };

        store.Publish(InstrumentRoot.MES, Request(1) with { Levels = [level] }, Publisher).Rejection.Should().Be(OverlayRejection.InvalidLevel);
    }

    [Theory]
    [InlineData(-0.01)]
    [InlineData(1.01)]
    public void Publish_ShouldReject_WhenSourceCoverageIsOutsideZeroToOne(double coverage)
    {
        var store = new OverlayStore(_time);

        store.Publish(InstrumentRoot.MES, Request(1) with { SourceCoverage = coverage }, Publisher).Rejection.Should().Be(OverlayRejection.InvalidLevel);
    }

    [Theory]
    [InlineData(5, true)]
    [InlineData(6, false)]
    public void Publish_ShouldAllowFiveSecondsOfClockSkew_WhenTheGeneratedTimeIsInTheFuture(int aheadSeconds, bool accepted)
    {
        var store = new OverlayStore(_time);

        var result = store.Publish(InstrumentRoot.MES, Request(1) with { GeneratedAt = Now.AddSeconds(aheadSeconds) }, Publisher);

        result.Accepted.Should().Be(accepted);
        if (!accepted)
        {
            result.Rejection.Should().Be(OverlayRejection.NotYetValid);
        }
    }

    [Fact]
    public void Publish_ShouldRejectAsTooLarge_WhenThereAreMoreThanTheMaximumLevels()
    {
        var store = new OverlayStore(_time);
        var levels = Enumerable.Range(0, OverlayStore.MaxLevels + 1)
            .Select(i => new OverlayLevel { Price = 6000m + (i * 0.25m), Label = "level" })
            .ToList();

        store.Publish(InstrumentRoot.MES, Request(1) with { Levels = levels }, Publisher).Rejection.Should().Be(OverlayRejection.TooLarge);
    }

    [Fact]
    public void Publish_ShouldRejectAsTooLarge_WhenTheRationaleIsTooLong()
    {
        var store = new OverlayStore(_time);

        var result = store.Publish(InstrumentRoot.MES, Request(1) with { Rationale = new string('r', OverlayStore.MaxRationaleLength + 1) }, Publisher);

        result.Rejection.Should().Be(OverlayRejection.TooLarge);
    }

    [Fact]
    public void Publish_ShouldAccept_WhenEveryListAndTextIsExactlyAtItsCap()
    {
        var store = new OverlayStore(_time);
        var levels = Enumerable.Range(0, OverlayStore.MaxLevels)
            .Select(i => new OverlayLevel { Price = 6000m + (i * 0.25m), Label = new string('l', OverlayStore.MaxLabelLength), Kind = new string('k', OverlayStore.MaxLabelLength) })
            .ToList();
        var flags = Enumerable.Range(0, OverlayStore.MaxQualityFlags).Select(_ => new string('f', OverlayStore.MaxLabelLength)).ToList();

        var result = store.Publish(
            InstrumentRoot.MES,
            Request(1) with { Levels = levels, QualityFlags = flags, Rationale = new string('r', OverlayStore.MaxRationaleLength) },
            Publisher);

        result.Accepted.Should().BeTrue();
    }

    [Fact]
    public void Publish_ShouldReject_WhenAFlagOrKindIsOneCharacterOverTheCap()
    {
        var store = new OverlayStore(_time);
        var tooLong = new string('x', OverlayStore.MaxLabelLength + 1);

        store.Publish(InstrumentRoot.MES, Request(1) with { QualityFlags = [tooLong] }, Publisher).Rejection.Should().Be(OverlayRejection.TooLarge);
        store.Publish(InstrumentRoot.MES, Request(1) with { Levels = [new OverlayLevel { Price = 6000.25m, Label = "l", Kind = tooLong }] }, Publisher)
            .Rejection.Should().Be(OverlayRejection.InvalidLevel);
    }

    [Fact]
    public void Caps_ShouldMatchTheDocumentedLimits()
    {
        // INTERFACES.md documents these numbers to agents; widening one is a contract change, not a refactor.
        (OverlayStore.MaxLevels, OverlayStore.MaxRationaleLength, OverlayStore.MaxLabelLength, OverlayStore.MaxQualityFlags)
            .Should().Be((50, 2000, 80, 10));
    }

    [Fact]
    public void Publish_ShouldRejectAnUnsupportedSchema_WhenTheSchemaVersionIsNotOne()
    {
        var store = new OverlayStore(_time);

        store.Publish(InstrumentRoot.MES, Request(1) with { SchemaVersion = 2 }, Publisher).Rejection.Should().Be(OverlayRejection.UnsupportedSchema);
    }

    [Theory]
    [InlineData(599, false)]
    [InlineData(600, true)]
    public void IsExpired_ShouldBeTrueFromTheExpiryInstant_WhenAskedAboutATime(int afterSeconds, bool expired)
    {
        var overlay = new OverlayStore(_time).Publish(InstrumentRoot.MES, Request(1), Publisher).Overlay!;

        overlay.IsExpired(Now.AddSeconds(afterSeconds)).Should().Be(expired);
    }

    /// <summary>A valid ES overlay generated now, expiring in ten minutes, with one synthetic level.</summary>
    private static OverlayRequest Request(long version) => new()
    {
        ContractId = TestData.EsContract,
        Version = version,
        GeneratedAt = Now,
        AsOf = Now,
        ExpiresAt = Now.AddMinutes(10),
        Levels = [new OverlayLevel { Price = 6000.25m, Label = "synthetic support", Kind = "support" }],
        Rationale = "Synthetic test overlay.",
    };
}
