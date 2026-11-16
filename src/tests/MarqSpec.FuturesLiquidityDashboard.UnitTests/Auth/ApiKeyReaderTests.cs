using MarqSpec.FuturesLiquidityDashboard.Api.Auth;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: ARCHITECTURE.md D-16, D-30
public sealed class ApiKeyReaderTests
{
    private const string Key = "synthetic-test-key";

    [Fact]
    public void PresentedKey_ShouldReturnTheHeader_WhenTheCallerSendsXApiKey()
    {
        ApiKeyReader.PresentedKey("/api/instruments", Key, null, null).Should().Be(Key);
    }

    [Fact]
    public void PresentedKey_ShouldReturnTheAccessToken_WhenTheHubRequestCarriesIt()
    {
        ApiKeyReader.PresentedKey("/hubs/market", null, Key, null).Should().Be(Key);
    }

    [Fact]
    public void PresentedKey_ShouldReturnTheBearerToken_WhenTheHubNegotiateRequestCarriesIt()
    {
        ApiKeyReader.PresentedKey("/hubs/market/negotiate", null, null, "Bearer " + Key).Should().Be(Key);
    }

    [Fact]
    public void PresentedKey_ShouldIgnoreTheAccessToken_WhenThePathOnlyStartsWithTheHubPrefix()
    {
        ApiKeyReader.PresentedKey("/hubsx", null, Key, "Bearer " + Key).Should().BeNull();
        ApiKeyReader.PresentedKey("/hubsfoo", null, Key, null).Should().BeNull();
        ApiKeyReader.PresentedKey("/hubs", null, Key, null).Should().Be(Key);
        ApiKeyReader.PresentedKey("/hubs/market", null, Key, null).Should().Be(Key);
    }

    [Fact]
    public void PresentedKey_ShouldIgnoreTheQueryAndBearer_WhenThePathIsNotTheHub()
    {
        ApiKeyReader.PresentedKey("/api/instruments", null, Key, "Bearer " + Key).Should().BeNull();
        ApiKeyReader.PresentedKey("/metrics", null, Key, "Bearer " + Key).Should().BeNull();
        ApiKeyReader.PresentedKey("/health/ready", null, Key, null).Should().BeNull();
    }

    [Fact]
    public void PresentedKey_ShouldPreferTheHeader_WhenTheHubAlsoHasAQueryToken()
    {
        ApiKeyReader.PresentedKey("/hubs/market", "header-key", "query-key", "Bearer bearer-key").Should().Be("header-key");
    }

    [Fact]
    public void PresentedKey_ShouldReturnNull_WhenNoKeyIsPresented()
    {
        ApiKeyReader.PresentedKey("/hubs/market", null, null, "Bearer ").Should().BeNull();
        ApiKeyReader.PresentedKey("/hubs/market", " ", Key, null).Should().Be(Key);
        ApiKeyReader.PresentedKey("/api/instruments", " ", null, null).Should().BeNull();
    }
}
