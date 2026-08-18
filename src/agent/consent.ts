import { createHash } from 'node:crypto';

/**
 * Pilot item 1: research-pilot informed consent, bilingual (Hebrew then
 * English). {{CRISIS_RESOURCES}} is substituted server-side by
 * renderConsentText — never hard-coded here. Bumping CONSENT_VERSION
 * forces every participant to re-consent, even ones who already agreed
 * to an earlier version.
 */
export const CONSENT_VERSION = 'v1';
export const CONSENT_TEXT_V1 = `--- HEBREW ---

**לפני שאתה מתחיל**

**זו מכונה.** לא מטפל, לא אדם, ולא תחליף לאף אחד מהם.

**היא עובדת בסגנון פסיכואנליטי.** לרוב היא לא תענה לשאלות, לא תיתן עצות, ולא תרגיע. לפעמים היא תחזיר לך מילה אחת שאמרת. לפעמים היא תגיד מעט מאוד. זה לא תקלה — זו הצורה.

**היא מסיימת את השיחה בעצמה.** כשהיא תחליט שזה הרגע, השיחה תסתיים — גם באמצע משפט — ולא תוכל לחזור אליה במשך 24 שעות.

**זו גרסת פיתוח, וזה מחקר.** כל מה שתכתוב נשמר. **Yaniv Pascal קורא את התמלולים** — זה חלק מהשיטה, לא תקלה. המטרה היא ללמוד איך התהליך עובד. המטרה איננה לטפל בך.

**אין הבטחה שזה יעזור.** ייתכן שזה יהיה מתסכל.

**זה לא מוקד חירום.** אם אתה כרגע במשבר, או בטיפול פסיכיאטרי אקוטי — אל תיכנס עכשיו. זה לא המקום.

{{CRISIS_RESOURCES}}

**אתה יכול לעצור בכל רגע** ולמחוק את הכל בלחיצה אחת — החשבון, השיחות, וכל מה שנשמר עליך. אין העתקים.

**גיל 18 ומעלה.**

שאלות: pascal.yaniv@gmail.com

☐ **קראתי, הבנתי, ואני מסכים.**

--- ENGLISH ---

**Before you begin**

**This is a machine.** Not a therapist, not a person, and not a substitute for either.

**It works in a psychoanalytic style.** It will usually not answer your questions, not give advice, and not reassure you. Sometimes it will return a single word you said. Sometimes it will say very little. That is not a malfunction — it is the form.

**It ends the session itself.** When it judges that the moment has come, the session stops — possibly mid-sentence — and you cannot return to it for 24 hours.

**This is a development build, and it is research.** Everything you write is stored. **Yaniv Pascal reads the transcripts** — this is part of the method, not a lapse. The purpose is to learn how the process works. The purpose is not to treat you.

**There is no promise that this will help.** It may be frustrating.

**This is not emergency care.** If you are in crisis right now, or in acute psychiatric treatment, do not start. This is not the place.

{{CRISIS_RESOURCES}}

**You can stop at any moment** and delete everything with one click — the account, the sessions, and everything stored about you. There are no copies.

**Ages 18 and over.**

Questions: pascal.yaniv@gmail.com

☐ **I have read this, I understand it, and I agree.**`;

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
