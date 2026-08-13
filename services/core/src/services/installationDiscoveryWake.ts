// W7-01: lightweight callback -> runtime wake signal for the installation-discovery
// dispatcher, mirroring `initialParseOutboxWake.ts` exactly. Keeping this registry separate
// prevents route imports from eagerly constructing the BullMQ dependency graph, and avoids a
// service<->dispatcher import cycle (the discovery service and the dispatcher would otherwise
// need to import each other directly).

let wakeHandler: (() => void) | null = null;

export function setInstallationDiscoveryWakeHandler(handler: (() => void) | null): void {
  wakeHandler = handler;
}

export function kickInstallationDiscoveryDispatcher(): void {
  wakeHandler?.();
}
