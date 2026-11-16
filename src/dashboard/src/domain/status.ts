/** The status chip's tone: LIVE green, REPLAY blue, SIMULATED amber, anything unhealthy red. */
export function chipTone(code: string): "live" | "replay" | "simulated" | "degraded" | "bad" {
  switch (code) {
    case "LIVE":
      return "live";
    case "REPLAY":
      return "replay";
    case "SIMULATED":
      return "simulated";
    case "DEGRADED":
      return "degraded";
    default:
      return "bad";
  }
}
