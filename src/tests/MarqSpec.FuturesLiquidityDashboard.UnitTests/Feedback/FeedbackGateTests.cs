using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md FR-74 (one request at a time per viewer, at most six a minute)
public sealed class FeedbackGateTests
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 19, 12, 0, 0, TimeSpan.Zero));

    private FeedbackGate Gate() => new(_time, Options.Create(new FeedbackOptions()));

    [Fact]
    public void TryEnter_ShouldRefuseTheSeventhStart_WhenSixStartedWithinAMinute()
    {
        var gate = Gate();
        for (var i = 0; i < 6; i++)
        {
            using var lease = gate.TryEnter("viewer").Lease;
            lease.Should().NotBeNull($"start {i + 1} is within the limit");
            _time.Advance(TimeSpan.FromSeconds(9));
        }

        var seventh = gate.TryEnter("viewer");

        seventh.Lease.Should().BeNull();
        seventh.Refusal!.Reason.Should().Be(FeedbackReasons.RateLimited);
        seventh.Refusal.RetryAfterSeconds.Should().Be(6, "the oldest start leaves the window 60 s after it, 54 s ago");
    }

    [Fact]
    public void TryEnter_ShouldAdmitAgain_WhenTheOldestStartIsAMinuteOld()
    {
        var gate = Gate();
        for (var i = 0; i < 6; i++)
        {
            gate.TryEnter("viewer").Lease!.Dispose();
        }

        _time.Advance(TimeSpan.FromSeconds(59));
        gate.TryEnter("viewer").Lease.Should().BeNull();
        _time.Advance(TimeSpan.FromSeconds(1));

        using var lease = gate.TryEnter("viewer").Lease;
        lease.Should().NotBeNull();
    }

    [Fact]
    public void TryEnter_ShouldRefuseASecondRequest_WhenTheFirstIsStillInFlight()
    {
        var gate = Gate();
        using var first = gate.TryEnter("viewer").Lease;

        var second = gate.TryEnter("viewer");

        second.Lease.Should().BeNull();
        second.Refusal.Should().Be(new FeedbackRefusal(FeedbackReasons.RequestInFlight, null));
    }

    [Fact]
    public void TryEnter_ShouldAdmit_WhenTheRequestInFlightHasEnded()
    {
        var gate = Gate();
        var first = gate.TryEnter("viewer").Lease!;
        first.Dispose();
        first.Dispose();

        using var second = gate.TryEnter("viewer").Lease;
        second.Should().NotBeNull();
        using var third = gate.TryEnter("viewer").Lease;
        third.Should().BeNull("a second dispose of the first lease must not free the second's slot");
    }

    [Fact]
    public void TryEnter_ShouldKeepViewersApart_WhenOneIsBusy()
    {
        var gate = Gate();
        using var a = gate.TryEnter("viewer-a").Lease;

        using var b = gate.TryEnter("viewer-b").Lease;

        b.Should().NotBeNull();
    }
}
