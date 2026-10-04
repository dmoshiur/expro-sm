/** Context + types shared by the toast provider and the useToast hook. */
import { createContext } from 'react';

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
}

export interface ToastContextValue {
  push: (kind: Toast['kind'], message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
