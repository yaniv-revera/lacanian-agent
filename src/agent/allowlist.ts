/**
 * Pilot item 2: a closed pilot with known participants. Comparison is
 * case-insensitive and tolerant of stray whitespace in the configured
 * list (ALLOWED_EMAILS is hand-edited, comma-separated).
 */
export function isEmailAllowed(email: string, allowlist: string[]): boolean {
  const target = email.trim().toLowerCase();
  return allowlist.some((e) => e.trim().toLowerCase() === target);
}
