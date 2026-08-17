import { createHash } from 'node:crypto';

/**
 * Pilot item 1: research-pilot informed consent. This is a placeholder —
 * the real text is supplied separately and will replace this constant.
 * Bumping CONSENT_VERSION forces every participant to re-consent, even
 * ones who already agreed to an earlier version.
 */
export const CONSENT_VERSION = 'v1';
export const CONSENT_TEXT_V1 =
  '[PLACEHOLDER — consent text to be supplied. Do not use this build with real participants until this is replaced.]';

export function hashConsentText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface ConsentStatus {
  consentedAt: number | null;
  consentVersion: string | null;
}

/** True if the participant has never consented, or consented to a since-superseded version. */
export function needsConsent(status: ConsentStatus, currentVersion: string): boolean {
  return status.consentedAt === null || status.consentVersion !== currentVersion;
}
