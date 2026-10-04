import { mergeConfig, type UserConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * Vitest runs the client component tests in jsdom, reusing the app's Vite
 * config (so the `@/` alias and React plugin behave exactly like the build).
 */
const appConfig = viteConfig as UserConfig;

export default mergeConfig(
  appConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: false,
      include: ['tests/**/*.test.{ts,tsx}'],
      setupFiles: ['./tests/setup.ts'],
      restoreMocks: true,
      css: false,
    },
  }),
);
