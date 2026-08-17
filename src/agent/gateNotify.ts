/**
 * Pilot item 3: minimum-viable escalation. With independent server-side
 * gate detection and full clinical escalation both still open blockers,
 * a human reviewer being paged the moment the gate latches is the
 * pilot's compensating control — it is deliberately simple.
 */
export function shouldNotifyGateLatch(wasLatched: boolean, isLatchedNow: boolean): boolean {
  return !wasLatched && isLatchedNow;
}

export interface GateNotification {
  userEmail: string;
  sessionId: number;
  turnIndex: number;
  transcriptUrl: string;
}

/**
 * No analysand text is ever passed to this function — there is nowhere
 * for it to leak into the email body. The reviewer opens transcriptUrl to
 * actually read the session.
 */
export function buildGateNotificationEmail(n: GateNotification): { subject: string; text: string } {
  return {
    subject: `[gate] session ${n.sessionId} latched`,
    text: [
      'The gate latched for a pilot participant.',
      '',
      `Participant: ${n.userEmail}`,
      `Session: ${n.sessionId}`,
      `Turn: ${n.turnIndex}`,
      '',
      `Transcript: ${n.transcriptUrl}`,
      '',
      'No message text is included in this email — open the transcript link to review.',
    ].join('\n'),
  };
}
