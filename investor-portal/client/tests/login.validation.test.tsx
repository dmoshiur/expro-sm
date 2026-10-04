/**
 * Sign-in form validation state.
 *
 * Bug being pinned: the "Required" messages were shown (and kept being shown)
 * even though both inputs held valid text, because react-hook-form could not
 * read the DOM inputs. Two things are asserted here:
 *
 *   1. "Required" only appears when a field was touched/blurred or a submit was
 *      attempted AND the field is actually empty.
 *   2. As soon as text is present the message clears - including right after a
 *      submit that reported it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from '@/pages/admin/Login';
import { authService } from '@/services/auth.service';

vi.mock('@/services/auth.service', () => ({
  authService: { login: vi.fn() },
}));

const loginMock = vi.mocked(authService.login);

const admin = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Super Admin',
  email: 'admin@investorportal.local',
  role: 'SUPER_ADMIN' as const,
  isActive: true,
  twoFAEnabled: true,
};

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Login />
    </MemoryRouter>,
  );
}

const emailRequired = () => screen.queryByText('Email is required');
const passwordRequired = () => screen.queryByText('Password is required');

describe('sign-in form validation state', () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  it('shows no "Required" message on a pristine form', () => {
    renderLogin();
    expect(emailRequired()).not.toBeInTheDocument();
    expect(passwordRequired()).not.toBeInTheDocument();
  });

  it('shows "Required" for a field only after it was touched and left empty', async () => {
    const user = userEvent.setup();
    renderLogin();

    const email = screen.getByLabelText('Email');
    await user.click(email);
    await user.tab(); // blur while still empty

    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    // the untouched password field stays quiet even though it is empty too
    expect(passwordRequired()).not.toBeInTheDocument();
  });

  it('clears "Required" as soon as text is entered', async () => {
    const user = userEvent.setup();
    renderLogin();

    const email = screen.getByLabelText('Email');
    await user.click(email);
    await user.tab();
    expect(await screen.findByText('Email is required')).toBeInTheDocument();

    await user.type(email, 'admin@investorportal.local');
    await waitFor(() => expect(emailRequired()).not.toBeInTheDocument());
  });

  it('submits the typed credentials instead of reporting them as empty', async () => {
    const user = userEvent.setup();
    loginMock.mockResolvedValue({ admin });
    renderLogin();

    await user.type(screen.getByLabelText('Email'), 'admin@investorportal.local');
    await user.type(screen.getByLabelText('Password'), 'Admin@12345');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith({
        email: 'admin@investorportal.local',
        password: 'Admin@12345',
      }),
    );
    expect(emailRequired()).not.toBeInTheDocument();
    expect(passwordRequired()).not.toBeInTheDocument();
  });

  it('reports empty fields on submit, then clears each message once text is typed', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    expect(await screen.findByText('Password is required')).toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Email'), 'admin@investorportal.local');
    await waitFor(() => expect(emailRequired()).not.toBeInTheDocument());
    expect(passwordRequired()).toBeInTheDocument(); // still empty -> still required
  });

  it('rejects a malformed email with the format message, not "Required"', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'Admin@12345');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(emailRequired()).not.toBeInTheDocument();
    expect(loginMock).not.toHaveBeenCalled();
  });
});
