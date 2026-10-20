/**
 * Off-canvas navigation drawer state, shared by the admin layout and the
 * investor portal. Below 1024px the sidebar slides in from the left; on wider
 * screens it is a persistent column (see the .sidebar rules in app.css).
 *
 * The drawer closes on navigation, on Escape and on backdrop tap, and it locks
 * body scrolling while it is open so the page behind does not move.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

export function useDrawer() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // Close whenever the route changes (a link was tapped inside the drawer).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return { open, setOpen, toggle: () => setOpen((value) => !value) };
}

export function DrawerToggle({ open, onToggle }) {
  return (
    <button
      type="button"
      className="menu-btn no-print"
      aria-label={open ? 'Close menu' : 'Open menu'}
      aria-expanded={open}
      aria-controls="app-drawer"
      onClick={onToggle}
    >
      <span aria-hidden="true">{open ? '✕' : '☰'}</span>
    </button>
  );
}

export function DrawerBackdrop({ open, onClose }) {
  return <div className={`drawer-backdrop no-print ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />;
}
