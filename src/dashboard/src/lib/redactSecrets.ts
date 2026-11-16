/** Removes viewer-key material from text before it is shown or stored (ARCHITECTURE.md D-30). */
export function redactSecrets(message: string): string {
  return message
    .replace(/access_token=[^&\s"']+/gi, "access_token=[redacted]")
    .replace(/(X-Api-Key\s*[:=]\s*)[^&\s]+/gi, "$1[redacted]")
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^&\s]+/gi, "$1[redacted]");
}
