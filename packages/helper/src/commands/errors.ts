import type { ErrorCode } from '../protocol.js';

export class ActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A signal's pid answered as another process afterwards: it was reused in
 * the instant between the identity check and the signal, so the signal may
 * have hit that other process. The helper raises it after signaling, and
 * the executor records the event in the journal before passing it on.
 */
export class PidReused extends ActionError {
  constructor(message: string) {
    super('refused', message);
  }
}
