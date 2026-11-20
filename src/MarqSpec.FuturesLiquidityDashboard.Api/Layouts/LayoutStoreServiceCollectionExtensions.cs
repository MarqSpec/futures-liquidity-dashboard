using Microsoft.Extensions.DependencyInjection.Extensions;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

/// <summary>Registers the saved-layout store and its file (ARCHITECTURE.md D-18).</summary>
public static class LayoutStoreServiceCollectionExtensions
{
    /// <summary>
    /// Binds <c>Layouts:*</c>, validated at start, anchors a relative <see cref="LayoutStoreOptions.StorePath"/> at the
    /// content root, and registers <see cref="LayoutStore"/> over the local disk. A blank path registers it memory only.
    /// </summary>
    public static IServiceCollection AddLayoutStore(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        services.AddOptions<LayoutStoreOptions>()
            .Bind(configuration.GetSection(LayoutStoreOptions.Section))
            .PostConfigure<IHostEnvironment>((options, environment) =>
            {
                // A blank path stays blank (memory only); one that names a directory is left for Validate to report.
                if (options.IsPersistent && options.Validate().Count == 0)
                {
                    options.StorePath = options.ResolvePath(environment.ContentRootPath);
                }
            })
            .Validate(options => options.Validate().Count == 0, "Layouts:StorePath must name a file, such as data/layouts.json, or be blank to keep layouts in memory only.")
            .ValidateOnStart();
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<ILayoutFileSystem, PhysicalLayoutFileSystem>();
        services.TryAddSingleton<LayoutStore>();
        return services;
    }
}
