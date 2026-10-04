import { describe, expect, it } from 'vitest';
import { fieldError, hasText, isRequiredMessage } from '@/lib/form';

describe('form error display rules', () => {
  it('never shows a message on a pristine field', () => {
    expect(fieldError({ message: 'Email is required', value: '', touched: false, submitted: false })).toBeUndefined();
    expect(fieldError({ message: 'Enter a valid email address', value: 'x', touched: false, submitted: false })).toBeUndefined();
  });

  it('shows "required" only when the field was touched/submitted and is empty', () => {
    expect(fieldError({ message: 'Email is required', value: '', touched: true, submitted: false })).toBe('Email is required');
    expect(fieldError({ message: 'Email is required', value: '   ', touched: true, submitted: false })).toBe('Email is required');
    expect(fieldError({ message: 'Email is required', value: '', touched: false, submitted: true })).toBe('Email is required');
  });

  it('clears "required" as soon as the field holds text', () => {
    expect(fieldError({ message: 'Email is required', value: 'admin@investorportal.local', touched: true, submitted: true })).toBeUndefined();
    expect(fieldError({ message: 'Password is required', value: 'x', touched: false, submitted: true })).toBeUndefined();
  });

  it('keeps format messages even when text is present', () => {
    expect(fieldError({ message: 'Enter a valid email address', value: 'nope', touched: true, submitted: true })).toBe('Enter a valid email address');
    expect(fieldError({ message: undefined, value: 'nope', touched: true, submitted: true })).toBeUndefined();
  });

  it('classifies messages and text as expected', () => {
    expect(isRequiredMessage('Email is required')).toBe(true);
    expect(isRequiredMessage('Required')).toBe(true);
    expect(isRequiredMessage('Enter a valid email address')).toBe(false);
    expect(isRequiredMessage(undefined)).toBe(false);
    expect(hasText('  a  ')).toBe(true);
    expect(hasText('   ')).toBe(false);
    expect(hasText(undefined)).toBe(false);
  });
});
