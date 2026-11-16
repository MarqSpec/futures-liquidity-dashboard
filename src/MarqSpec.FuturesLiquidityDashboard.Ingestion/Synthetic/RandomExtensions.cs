namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Synthetic;

/// <summary>The distributions the synthetic market draws from, over a seeded <see cref="Random"/>.</summary>
public static class RandomExtensions
{
    /// <summary>A standard normal sample (Box–Muller).</summary>
    public static double NextGaussian(this Random random)
    {
        ArgumentNullException.ThrowIfNull(random);
        var u1 = 1.0 - random.NextDouble();
        var u2 = random.NextDouble();
        return Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(2.0 * Math.PI * u2);
    }

    /// <summary>A Poisson count with mean <paramref name="lambda"/>; a normal approximation above 30.</summary>
    public static int NextPoisson(this Random random, double lambda)
    {
        ArgumentNullException.ThrowIfNull(random);
        if (lambda <= 0)
        {
            return 0;
        }

        if (lambda > 30)
        {
            return Math.Max(0, (int)Math.Round(lambda + (Math.Sqrt(lambda) * random.NextGaussian())));
        }

        var limit = Math.Exp(-lambda);
        var count = 0;
        var product = random.NextDouble();
        while (product > limit)
        {
            count++;
            product *= random.NextDouble();
        }

        return count;
    }

    /// <summary>A geometric size of at least 1 with the given mean: the long tail of trade and order sizes.</summary>
    public static long NextGeometric(this Random random, double mean)
    {
        ArgumentNullException.ThrowIfNull(random);
        if (mean <= 1)
        {
            return 1;
        }

        var p = 1.0 / mean;
        var u = 1.0 - random.NextDouble();
        return 1 + (long)Math.Floor(Math.Log(u) / Math.Log(1 - p));
    }
}
