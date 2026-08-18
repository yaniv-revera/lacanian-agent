import { createHash } from 'node:crypto';

/**
 * Pilot item 1: research-pilot informed consent. This is a placeholder —
 * the real text is supplied separately and will replace this constant.
 * Bumping CONSENT_VERSION forces every participant to re-consent, even
 * ones who already agreed to an earlier version.
 */
export const CONSENT_VERSION = 'v1';
export const CONSENT_TEXT_V1 =
  '[PLACEHOLDER — consent text to be supplied, both languages, with {{CRISIS_RESOURCES}} left ' +
  'in place. Do not use this build with real participants until this is replaced.]';

export function hashConsentText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The stored hash covers the raw template (placeholder token intact), not
 * this rendered output — the crisis-resources text can be reconfigured
 * without that being a change to the consent terms themselves. An
 * unconfigured resource ('UNAVAILABLE', config.ts's sentinel) never
 * renders as a fabricated number; it renders as nothing, the same
 * never-invent rule the analyst itself follows.
 */
export function renderConsentText(template: string, crisisResources: string): string {
  const value = crisisResources === 'UNAVAILABLE' ? '' : crisisResources;
  return template.split('{{CRISIS_RESOURCES}}').join(value);
}

export interface ConsentStatus {
  consentedAt: number | null;
  consentVersion: string | null;
}

/** True if the participant has never consented, or consented to a since-superseded version. */
export function needsConsent(status: ConsentStatus, currentVersion: string): boolean {
  return status.consentedAt === null || status.consentVersion !== currentVersion;
}
