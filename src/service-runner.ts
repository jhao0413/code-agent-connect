import { sleep, toErrorMessage } from './utils.js';

export interface PersistentServiceContext {
  attempt: number;
  error: unknown;
  exited: boolean;
}

export interface RunPersistentServiceOptions {
  retryDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  shouldRestart?: (context: PersistentServiceContext) => boolean;
}

export async function runPersistentService(
  name: string,
  run: () => Promise<void>,
  {
    retryDelayMs = 2000,
    sleepImpl = sleep,
    log = (line) => console.error(line),
    shouldRestart = () => true,
  }: RunPersistentServiceOptions = {},
): Promise<void> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    let error: unknown = null;
    let exited = false;

    try {
      await run();
      exited = true;
    } catch (caught) {
      error = caught;
    }

    const context = { attempt, error, exited };
    if (!shouldRestart(context)) {
      return;
    }

    const reason = exited
      ? 'service stopped unexpectedly'
      : `service crashed: ${toErrorMessage(error)}`;
    log(`[${name}] ${reason}; restarting in ${retryDelayMs}ms`);
    await sleepImpl(retryDelayMs);
  }
}
