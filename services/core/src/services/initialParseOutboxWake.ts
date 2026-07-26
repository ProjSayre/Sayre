// Lightweight callback -> runtime wake signal. Keeping this registry separate
// prevents browser-route imports from eagerly constructing the SQS client
// dependency graph; the Core entrypoint installs the handler before listen().

let wakeHandler: (() => void) | null = null;

export function setInitialParseOutboxWakeHandler(handler: (() => void) | null): void {
  wakeHandler = handler;
}

export function kickInitialParseOutboxDispatcher(): void {
  wakeHandler?.();
}
