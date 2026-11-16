// Harness lifecycle: ephemeral listener, registration, then poll until explicitly done.
import { createApp } from './app.ts';

const environment = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const delay = (attempt: number) => Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(`${environment}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }), signal: AbortSignal.timeout(30_000),
      });
    } catch { /* The harness may still be starting. */ }
    if (response?.status === 200 || response?.status === 409) return;
    if (response?.status === 400 || response?.status === 405) throw new Error(`register answered HTTP ${response.status}`);
    await response?.body?.cancel();
    await sleep(delay(attempt));
  }
}
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${environment}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.done === true) return;
      } else await response.body?.cancel();
    } catch { /* Only an explicit done:true ends the trial. */ }
    await sleep(delay(attempt));
  }
}
async function main(): Promise<void> {
  if (!environment) throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  process.stdout.write('[entry] done\n');
}
try { await main(); process.exit(0); }
catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
