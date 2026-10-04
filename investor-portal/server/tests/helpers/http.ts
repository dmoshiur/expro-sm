/** HTTP test helpers built on supertest. */
import request from 'supertest';
import type { SuperAgentTest } from 'supertest';
import { createApp } from '../../src/app';
import { TEST_PASSWORD } from './db';

export const app = createApp();

/** A supertest agent keeps cookies between requests, like a browser. */
export const agent = (): SuperAgentTest => request.agent(app) as unknown as SuperAgentTest;

export interface LoginOptions {
  email: string;
  password?: string;
  totp?: string;
}

/** Logs in and returns the agent (cookies attached) plus the response body. */
export async function loginWith(options: LoginOptions) {
  const client = agent();
  const response = await client
    .post('/api/auth/login')
    .send({ email: options.email, password: options.password ?? TEST_PASSWORD, ...(options.totp ? { totp: options.totp } : {}) })
    .expect((res) => {
      if (![200, 401, 403].includes(res.status)) {
        throw new Error(`unexpected login status ${res.status}: ${JSON.stringify(res.body)}`);
      }
    });
  return { client, response };
}

export const cookiesOf = (response: request.Response): string[] =>
  (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

export const cookieValue = (response: request.Response, name: string): string | undefined =>
  cookiesOf(response)
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.split('=')[1];

export { request };
