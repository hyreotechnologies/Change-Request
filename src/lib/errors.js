export class AppError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

export const errors = {
  authRequired: (m = 'Authentication required') => new AppError('AUTH_REQUIRED', m, 401),
  forbidden: (m = 'You do not have permission to perform this action') => new AppError('FORBIDDEN', m, 403),
  notFound: (m = 'Resource not found') => new AppError('NOT_FOUND', m, 404),
  validation: (m = 'Validation failed', details = null) => new AppError('VALIDATION_FAILED', m, 422, details),
  invalidState: (m = 'Action not allowed in the current state') => new AppError('INVALID_STATE', m, 409),
  duplicate: (m = 'A record with this value already exists', details = null) =>
    new AppError('DUPLICATE', m, 409, details),
  locked: (m = 'This record is locked for editing') => new AppError('LOCKED', m, 423),
  rateLimited: (m = 'Too many requests, please try again later') => new AppError('RATE_LIMITED', m, 429),
  otpInvalid: (m = 'The code you entered is not valid') => new AppError('OTP_INVALID', m, 400),
  otpExpired: (m = 'This code has expired, please request a new one') => new AppError('OTP_EXPIRED', m, 400),
  integration: (m = 'The external service could not be reached', details = null) =>
    new AppError('INTEGRATION_ERROR', m, 502, details),
  internal: (m = 'Something went wrong') => new AppError('INTERNAL', m, 500)
};

/** Translate SQLite constraint failures into meaningful API errors. */
export function translateDbError(error) {
  const message = String(error?.message || '');
  if (message.includes('ux_msa_reference')) {
    return errors.duplicate('This MSA reference number is already registered against another account', {
      field: 'msa_reference_number'
    });
  }
  if (message.includes('ux_accounts_code')) {
    return errors.duplicate('This account code is already in use', { field: 'account_code' });
  }
  if (message.includes('ux_accounts_name')) {
    return errors.duplicate('An account with this name already exists', { field: 'account_name' });
  }
  if (message.includes('ux_cr_number') || message.includes('ux_cr_reference') || message.includes('ux_cr_account_seq')) {
    return errors.duplicate('This change request number already exists', { field: 'cr_number' });
  }
  if (message.includes('ux_users_email')) {
    return errors.duplicate('A user with this email address already exists', { field: 'email' });
  }
  if (message.includes('append-only')) {
    return errors.forbidden('Audit records cannot be modified or deleted');
  }
  if (message.includes('Locked document versions')) {
    return errors.forbidden('Approved document versions are immutable');
  }
  if (message.includes('Only draft change requests')) {
    return errors.invalidState('Only draft change requests may be deleted');
  }
  if (message.includes('cannot be modified')) {
    return errors.invalidState('Completed, cancelled or expired change requests cannot be modified');
  }
  if (message.includes('is locked for editing')) {
    return errors.locked('This change request is locked for editing');
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return errors.invalidState('This record is referenced by other data and cannot be changed');
  }
  if (message.includes('UNIQUE constraint failed')) {
    return errors.duplicate('A record with this value already exists');
  }
  return null;
}
