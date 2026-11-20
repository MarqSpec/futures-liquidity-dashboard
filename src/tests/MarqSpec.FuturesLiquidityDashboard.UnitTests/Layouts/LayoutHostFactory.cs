using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Layouts;

// A host-booting unit test (CONVENTIONS.md §8.1): what it guards exists only in the composition, namely that
// AddLayoutStore binds Layouts:StorePath, anchors it at the content root, validates it at start and that the layout
// routes reach the store. One product on the synthetic feed; the disk is the faked LayoutDisk, so nothing is written.

/// <summary>Production, one synthetic viewer key, layouts on <paramref name="disk"/>.</summary>
internal sealed class LayoutHostFactory(LayoutDisk disk, Dictionary<string, string?>? overrides = null) : WebApplicationFactory<Program>
{
    public const string ViewerKey = "synthetic-layout-viewer-key";

    private readonly Dictionary<string, string?> _settings = new()
    {
        ["Feed:Provider"] = "Synthetic",
        ["Feed:MinHistoryHours"] = "0.1",
        ["Feed:WarmRegimes"] = "false",
        ["Feed:Synthetic:StepMs"] = "50",
        ["Engine:Instruments:0"] = "MES",
        ["Agent:Enabled"] = "false",
        ["Feedback:Enabled"] = "false",
        // Neither file store reads or writes the real disk: the layout seam is faked, the budget is memory only.
        ["Feedback:BudgetStorePath"] = string.Empty,
        ["Auth:Keys:0:Name"] = "layout-viewer",
        ["Auth:Keys:0:KeySha256"] = ApiKeyAuthenticationHandler.HashKey(ViewerKey),
        ["Auth:Keys:0:Grants:0"] = "view-dashboard:MES",
        ["Auth:Keys:0:Grants:1"] = "configure-layout:MES",
    };

    public HttpClient Viewer()
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add(ApiKeyAuthenticationHandler.Header, ViewerKey);
        return client;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.UseEnvironment("Production");
        foreach (var (key, value) in _settings.Concat(overrides ?? []))
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<ILayoutFileSystem>();
            services.AddSingleton(disk.FileSystem);
        });
    }
}
