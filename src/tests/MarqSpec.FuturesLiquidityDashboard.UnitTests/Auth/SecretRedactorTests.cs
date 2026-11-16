using MarqSpec.FuturesLiquidityDashboard.Api.Auth;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: ARCHITECTURE.md D-30; CONVENTIONS.md §11
public sealed class SecretRedactorTests
{
    private const string Key = "synthetic-test-key-es-viewer";

    [Fact]
    public void Redact_ShouldRemoveTheAccessToken_WhenTheMessageContainsTheQuery()
    {
        var line = $"Request starting HTTP/1.1 GET http://localhost/hubs/market?id=abc&access_token={Key} - 0";

        var redacted = SecretRedactor.Redact(line);

        redacted.Should().NotContain(Key);
        redacted.Should().Contain("access_token=[redacted]");
        redacted.Should().Contain("id=abc");
    }

    [Fact]
    public void Redact_ShouldRemoveTheApiKeyHeader_WhenTheMessageContainsIt()
    {
        SecretRedactor.Redact($"Header X-Api-Key: {Key}").Should().Be("Header X-Api-Key: [redacted]");
        SecretRedactor.Redact($"X-Api-Key={Key}&next=1").Should().Be("X-Api-Key=[redacted]&next=1");
    }

    [Fact]
    public void Redact_ShouldRemoveABearerToken_WhenTheMessageContainsIt()
    {
        SecretRedactor.Redact($"Authorization: Bearer {Key}").Should().Be("Authorization: Bearer [redacted]");
    }

    [Fact]
    public void Redact_ShouldRemoveAJwt_WhenTheMessageContainsOne()
    {
        const string jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";

        SecretRedactor.Redact("upstream " + jwt).Should().Be("upstream [redacted]");
    }

    [Fact]
    public void Redact_ShouldLeaveTheHostname_WhenAJwtIsGluedToIt()
    {
        const string jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";

        SecretRedactor.Redact(jwt + ".example.com").Should().Be("[redacted].example.com");
    }

    [Fact]
    public void Redact_ShouldRemoveATruncatedJwt_WhenItHasFewerThanThreeSegments()
    {
        const string header = "eyJhbGciOiJub25lIn0";
        const string payload = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";

        SecretRedactor.Redact("upstream " + header).Should().Be("upstream [redacted]");
        SecretRedactor.Redact("upstream " + header + "." + payload).Should().Be("upstream [redacted]");
        SecretRedactor.Redact("upstream " + header + "." + payload + ".").Should().Be("upstream [redacted]");
    }

    [Fact]
    public void Redact_ShouldRemoveASpacedAccessToken_WhenEqualsHasSpaceAroundIt()
    {
        SecretRedactor.Redact("{ access_token = " + Key + " }").Should().Be("{ access_token=[redacted] }");
    }

    [Fact]
    public void Redact_ShouldLeaveTheNextLine_WhenTheAccessTokenHasNoValue()
    {
        SecretRedactor.Redact("access_token=\nNextLine").Should().Be("access_token=\nNextLine");
    }

    [Fact]
    public void Redact_ShouldLeaveOrdinaryDottedText_WhenItIsNotAJwt()
    {
        SecretRedactor.Redact("file.payload.sig").Should().Be("file.payload.sig");
        SecretRedactor.Redact("MES.Z26").Should().Be("MES.Z26");
        SecretRedactor.Redact("v1.2.3").Should().Be("v1.2.3");
        SecretRedactor.Redact("System.Collections.Generic").Should().Be("System.Collections.Generic");
    }

    [Fact]
    public void Redact_ShouldLeaveOrdinaryText_WhenThereIsNoSecret()
    {
        const string line = "Streaming Synthetic for 3 instruments";

        SecretRedactor.Redact(line).Should().Be(line);
        SecretRedactor.Redact(null).Should().BeEmpty();
    }
}
