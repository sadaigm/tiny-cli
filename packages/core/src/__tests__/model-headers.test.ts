jest.mock('node-fetch', () => ({ default: jest.fn() }));

import { ModelClient } from '../model/client.js';

describe('ModelClient header resolution & priority', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, TEST_SECRET_KEY: 'secret-token-xyz' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('sets default Authorization header when apiKey is provided', () => {
    const client = new ModelClient({
      endpoint: 'http://localhost:11434/v1',
      model: 'test-model',
      apiKey: 'my-api-key',
    });

    const headers = (client as any).getHeaders();
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer my-api-key');
  });

  it('does not set Authorization header when apiKey is omitted or none', () => {
    const client = new ModelClient({
      endpoint: 'http://localhost:11434/v1',
      model: 'test-model',
    });

    const headers = (client as any).getHeaders();
    expect(headers['Authorization']).toBeUndefined();
  });

  it('adds custom headers alongside default Authorization', () => {
    const client = new ModelClient({
      endpoint: 'http://localhost:11434/v1',
      model: 'test-model',
      apiKey: 'my-api-key',
      headers: {
        'x-custom-org': 'my-org',
        'anthropic-version': '2023-06-01',
      },
    });

    const headers = (client as any).getHeaders();
    expect(headers['Authorization']).toBe('Bearer my-api-key');
    expect(headers['x-custom-org']).toBe('my-org');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('allows custom headers to override Authorization (case-insensitive)', () => {
    const client = new ModelClient({
      endpoint: 'http://localhost:11434/v1',
      model: 'test-model',
      apiKey: 'default-key',
      headers: {
        authorization: 'Basic dXNlcjpwYXNz',
      },
    });

    const headers = (client as any).getHeaders();
    expect(headers['authorization']).toBe('Basic dXNlcjpwYXNz');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('expands ${ENV_VAR} references inside custom headers', () => {
    const client = new ModelClient({
      endpoint: 'http://localhost:11434/v1',
      model: 'test-model',
      headers: {
        'x-api-key': '${TEST_SECRET_KEY}',
      },
    });

    const headers = (client as any).getHeaders();
    expect(headers['x-api-key']).toBe('secret-token-xyz');
  });
});
