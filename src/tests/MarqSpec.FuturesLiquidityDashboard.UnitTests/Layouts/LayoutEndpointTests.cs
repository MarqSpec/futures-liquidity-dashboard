using System.Net;
using System.Text;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Layouts;

// reference: REQUIREMENTS.md FR-9, FR-72, NFR-6; INTERFACES.md D.1; ARCHITECTURE.md D-18
// Two hosts over one faked disk are an API restart: the first is disposed before the second starts.
public sealed class LayoutEndpointTests : IDisposable
{
    private static readonly Uri Layouts = new("/api/layouts/me", UriKind.Relative);

    private readonly LayoutDisk _disk = new();
    private readonly List<LayoutHostFactory> _hosts = [];

    public void Dispose()
    {
        foreach (var host in _hosts)
        {
            host.Dispose();
        }
    }

    private LayoutHostFactory Host(Dictionary<string, string?>? overrides = null)
    {
        var host = new LayoutHostFactory(_disk, overrides);
        _hosts.Add(host);
        return host;
    }

    private static string ActiveMesContract(LayoutHostFactory host)
    {
        host.Services.GetRequiredService<EngineRegistry>().TryGet(InstrumentRoot.MES, out var engine).Should().BeTrue();
        return engine!.Spec.ContractId;
    }

    private static StringContent Write(long revision, string contractId) => new(
        $$"""{"revision":{{revision}},"layout":{"instrument":"MES","historyMinutes":45,"positions":{"MES":""" +
            LayoutStoreTests.FilledLong.Replace("MESZ26", contractId, StringComparison.Ordinal) + "}}}",
        Encoding.UTF8,
        "application/json");

    private static async Task<JsonDocument> Read(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync());

    /// <summary>Saves the filled long through the first host, then stops it.</summary>
    private async Task<string> SaveThenStop()
    {
        var first = Host();
        using var client = first.Viewer();
        var contract = ActiveMesContract(first);
        using var put = await client.PutAsync(Layouts, Write(0, contract));
        put.StatusCode.Should().Be(HttpStatusCode.OK);
        first.Dispose();
        return contract;
    }

    [Fact]
    public async Task GetLayout_ShouldReturnTheSavedPositionWithItsTracking_WhenTheApiRestarts()
    {
        await SaveThenStop();
        using var client = Host().Viewer();

        using var read = await Read(await client.GetAsync(Layouts));

        read.RootElement.GetProperty("saved").GetBoolean().Should().BeTrue();
        read.RootElement.GetProperty("revision").GetInt64().Should().Be(1);
        var layout = read.RootElement.GetProperty("layout");
        layout.GetProperty("historyMinutes").GetInt32().Should().Be(45);
        var position = layout.GetProperty("positions").GetProperty("MES");
        position.GetProperty("state").GetString().Should().Be("filled");
        position.GetProperty("fill").GetProperty("riskTicks").GetDecimal().Should().Be(10);
        position.GetProperty("exits").GetArrayLength().Should().Be(1);
        position.GetProperty("targets").GetArrayLength().Should().Be(2);
    }

    [Fact]
    public async Task PutLayout_ShouldAnswerConflict_WhenARestartedApiIsSentRevisionZero()
    {
        var contract = await SaveThenStop();
        using var client = Host().Viewer();

        using var stale = await client.PutAsync(Layouts, Write(0, contract));
        using var next = await client.PutAsync(Layouts, Write(1, contract));

        stale.StatusCode.Should().Be(HttpStatusCode.Conflict, "the counter survived the restart");
        next.StatusCode.Should().Be(HttpStatusCode.OK);
        using var body = await Read(next);
        body.RootElement.GetProperty("revision").GetInt64().Should().Be(2);
    }

    [Fact]
    public async Task PutLayout_ShouldWriteTheStoreUnderTheContentRoot_WhenStorePathIsNotSet()
    {
        var host = Host();
        var expected = Path.GetFullPath(Path.Combine(host.Services.GetRequiredService<IHostEnvironment>().ContentRootPath, "data", "layouts.json"));
        using var client = host.Viewer();

        using var put = await client.PutAsync(Layouts, Write(0, ActiveMesContract(host)));

        put.StatusCode.Should().Be(HttpStatusCode.OK);
        _disk.Files.Keys.Should().Equal(expected);
    }

    [Fact]
    public async Task PutLayout_ShouldWriteNoKeyMaterial_WhenAViewerSaves()
    {
        var host = Host();
        using var client = host.Viewer();

        using var put = await client.PutAsync(Layouts, Write(0, ActiveMesContract(host)));

        put.StatusCode.Should().Be(HttpStatusCode.OK);
        var stored = _disk.Files.Values.Should().ContainSingle().Which;
        stored.Should().NotContain(LayoutHostFactory.ViewerKey).And.NotContain(ApiKeyAuthenticationHandler.HashKey(LayoutHostFactory.ViewerKey));
    }

    [Fact]
    public async Task GetLayout_ShouldReportUnsaved_WhenTheStoreFileIsCorrupt()
    {
        var path = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "layout-volume", "layouts.json"));
        _disk.Files[path] = "{\"version\":1,\"layouts\":";
        using var client = Host(new() { ["Layouts:StorePath"] = path }).Viewer();

        using var response = await client.GetAsync(Layouts);

        response.StatusCode.Should().Be(HttpStatusCode.OK, "a corrupt store is a safe default, never a failure");
        using var read = await Read(response);
        read.RootElement.GetProperty("saved").GetBoolean().Should().BeFalse();
        read.RootElement.GetProperty("revision").GetInt64().Should().Be(0);
    }

    [Fact]
    public async Task PutLayout_ShouldAnswerServiceUnavailable_WhenTheStoreCannotBeWritten()
    {
        var path = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "layout-volume", "layouts.json"));
        A.CallTo(() => _disk.FileSystem.Replace(A<string>._, A<string>._)).Throws(new UnauthorizedAccessException($"Access to the path '{path}' is denied."));
        var host = Host(new() { ["Layouts:StorePath"] = path });
        using var client = host.Viewer();

        using var put = await client.PutAsync(Layouts, Write(0, ActiveMesContract(host)));
        var body = await put.Content.ReadAsStringAsync();

        put.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        put.Content.Headers.ContentType!.MediaType.Should().Be("application/problem+json");
        body.Should().Contain("layout-store-unavailable").And.NotContain("layout-volume").And.NotContain("denied");
    }

    [Fact]
    public async Task GetLayout_ShouldServeThePreviousRevision_WhenAPutCouldNotBeWritten()
    {
        var host = Host();
        using var client = host.Viewer();
        var contract = ActiveMesContract(host);
        using var first = await client.PutAsync(Layouts, Write(0, contract));
        A.CallTo(() => _disk.FileSystem.Replace(A<string>._, A<string>._)).Throws(new IOException("disk full"));

        using var failed = await client.PutAsync(Layouts, Write(1, contract));
        using var read = await Read(await client.GetAsync(Layouts));

        failed.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        read.RootElement.GetProperty("revision").GetInt64().Should().Be(1);
    }

    [Fact]
    public async Task PutLayout_ShouldTouchNoFile_WhenStorePathIsBlank()
    {
        var host = Host(new() { ["Layouts:StorePath"] = string.Empty });
        using var client = host.Viewer();

        using var put = await client.PutAsync(Layouts, Write(0, ActiveMesContract(host)));

        put.StatusCode.Should().Be(HttpStatusCode.OK);
        Fake.GetCalls(_disk.FileSystem).Should().BeEmpty("a blank path keeps layouts in memory only");
    }

    [Fact]
    public async Task GetLayout_ShouldReportUnsaved_WhenStorePathIsBlankAndTheApiRestarts()
    {
        var blank = new Dictionary<string, string?> { ["Layouts:StorePath"] = string.Empty };
        var first = Host(blank);
        using (var client = first.Viewer())
        {
            using var put = await client.PutAsync(Layouts, Write(0, ActiveMesContract(first)));
            put.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        first.Dispose();
        using var restarted = Host(blank).Viewer();

        using var read = await Read(await restarted.GetAsync(Layouts));

        read.RootElement.GetProperty("saved").GetBoolean().Should().BeFalse();
    }

    [Theory]
    [InlineData("data/")]
    [InlineData("data\\")]
    public void Startup_ShouldFail_WhenStorePathNamesADirectory(string path)
    {
        var act = () => Host(new() { ["Layouts:StorePath"] = path }).Viewer();

        act.Should().Throw<OptionsValidationException>().Which.Message.Should().Contain("Layouts:StorePath");
    }
}
