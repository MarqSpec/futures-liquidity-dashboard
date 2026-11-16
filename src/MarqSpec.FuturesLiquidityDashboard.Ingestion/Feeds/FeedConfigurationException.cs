namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

/// <summary>
/// A feed setting names something the upstream does not have, such as a contract id that does not exist. Retrying
/// cannot fix it, so the ingestion service stops instead of restarting (ARCHITECTURE.md D-11).
/// The message names the setting, never a credential.
/// </summary>
public sealed class FeedConfigurationException : InvalidOperationException
{
    public FeedConfigurationException()
    {
    }

    public FeedConfigurationException(string message)
        : base(message)
    {
    }

    public FeedConfigurationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
