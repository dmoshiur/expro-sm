/**
 * Form error display helpers.
 *
 * These encode the validation-state rules the UI must follow:
 *  1. a message is only shown once the field was touched/blurred or the form
 *     was submitted - never on a pristine form;
 *  2. a "required" message disappears again as soon as the field holds text
 *     (even right after a submit that reported it).
 */

/** True when the user has typed something meaningful into the field. */
export function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True for "… is required" / "Required" style resolver messages. */
export function isRequiredMessage(message?: string): boolean {
  return typeof message === 'string' && /required/i.test(message);
}

export interface FieldErrorInput {
  /** `formState.errors[name]?.message` */
  message?: string;
  /** current value of the field (from `watch`) */
  value?: unknown;
  /** `formState.touchedFields[name]` - set after the field was blurred */
  touched?: boolean;
  /** `formState.isSubmitted` - a submit attempt counts as "everything touched" */
  submitted?: boolean;
}

/**
 * Returns the message that should be rendered for a field, or `undefined` when
 * nothing should be shown. Also covers array/`FieldError`-style messages.
 */
export function fieldError({ message, value, touched, submitted }: FieldErrorInput): string | undefined {
  if (!message) return undefined;
  if (!touched && !submitted) return undefined;
  if (isRequiredMessage(message) && hasText(value)) return undefined;
  return message;
}
