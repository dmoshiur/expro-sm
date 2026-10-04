/**
 * Shared UI primitives must forward refs to their DOM nodes.
 *
 * Every form in the app spreads react-hook-form's `register()` output onto
 * `<Input>`/`<Select>`. Those props include a `ref`, and a plain function
 * component silently drops it on React 18 - which made every field look empty
 * to the resolver. These tests pin the contract.
 */
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Field, Input, Select } from '@/components/ui';

describe('form primitives', () => {
  it('forwards refs to the underlying input and select elements', () => {
    const inputRef = createRef<HTMLInputElement>();
    const selectRef = createRef<HTMLSelectElement>();

    render(
      <>
        <Input ref={inputRef} placeholder="name" />
        <Select ref={selectRef}>
          <option value="a">A</option>
        </Select>
      </>,
    );

    expect(inputRef.current).toBeInstanceOf(HTMLInputElement);
    expect(selectRef.current).toBeInstanceOf(HTMLSelectElement);
  });

  it('associates the Field label with the control and announces errors', () => {
    const { getByLabelText, getByRole } = render(
      <Field label="Email" htmlFor="email-field" error="Email is required">
        <Input id="email-field" />
      </Field>,
    );

    expect(getByLabelText('Email')).toBeInstanceOf(HTMLInputElement);
    expect(getByRole('alert')).toHaveTextContent('Email is required');
  });
});
