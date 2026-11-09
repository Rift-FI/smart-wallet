/**
 * Typed errors for the passkey wallet API. `code` is what goes on the
 * wire as `{ error: code }`; `status` is the HTTP status the route uses.
 */

export type PasskeyErrorCode =
  | "VALIDATION_ERROR"
  | "UNSUPPORTED_CHAIN"
  | "PASSKEY_UNSUPPORTED_ON_CHAIN"
  | "PASSKEY_REQUIRED"
  | "INVALID_PASSKEY_SIGNATURE"
  | "SIGNER_NOT_OWNER"
  | "ACCOUNT_MISMATCH"
  | "TICKET_NOT_FOUND"
  | "MIGRATION_REQUIRED"
  | "MIGRATION_NEEDS_GAS"
  | "MIGRATION_CALLDATA_REJECTED"
  | "EOA_MISMATCH"
  | "LAST_OWNER"
  | "NOT_AN_OWNER"
  | "CONFIGURATION_ERROR"
  | "PREPARE_FAILED"
  | "SUBMIT_FAILED";

const DEFAULT_STATUS: Record<PasskeyErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNSUPPORTED_CHAIN: 400,
  PASSKEY_UNSUPPORTED_ON_CHAIN: 400,
  PASSKEY_REQUIRED: 400,
  INVALID_PASSKEY_SIGNATURE: 400,
  SIGNER_NOT_OWNER: 400,
  ACCOUNT_MISMATCH: 400,
  TICKET_NOT_FOUND: 404,
  MIGRATION_REQUIRED: 409,
  MIGRATION_NEEDS_GAS: 409,
  MIGRATION_CALLDATA_REJECTED: 400,
  EOA_MISMATCH: 400,
  LAST_OWNER: 409,
  NOT_AN_OWNER: 400,
  CONFIGURATION_ERROR: 500,
  PREPARE_FAILED: 400,
  SUBMIT_FAILED: 400,
};

export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: PasskeyErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PasskeyError";
    this.code = code;
    this.status = DEFAULT_STATUS[code];
    if (details) this.details = details;
  }
}

export function isPasskeyError(e: unknown): e is PasskeyError {
  return e instanceof PasskeyError;
}
