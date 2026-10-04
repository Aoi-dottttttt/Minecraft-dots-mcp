/** Secret redaction for log/error text. */

/**
 * Replace any occurrence of the given secret values in `text` with "***".
 * Used so a connection-failure message (or any forwarded error) can never echo
 * a password / access token / client token back to the MCP client or stderr.
 * Short values (< 4 chars) are ignored to avoid mangling unrelated text.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("***");
  }
  return out;
}
