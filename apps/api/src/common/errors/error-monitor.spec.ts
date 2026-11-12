import { getConfig } from '../config/env';
import { ErrorMonitor } from './error-monitor';

it('sends only allowlisted telemetry to a configured Sentry endpoint', () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
  try {
    new ErrorMonitor({ ...getConfig(), sentryDsn: undefined }).capture(new Error('ignored'));
    expect(fetch).not.toHaveBeenCalled();
    const error = Object.assign(new Error('cookie=private; password=private'), { code: 'P2001' });
    new ErrorMonitor({ ...getConfig(), sentryDsn: 'https://public@errors.example.invalid/team/7' }).capture(error);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://errors.example.invalid/team/api/7/envelope/');
    expect(init?.body).toContain('P2001');
    expect(init?.body).not.toContain('private');
  } finally {
    fetch.mockRestore();
  }
});
