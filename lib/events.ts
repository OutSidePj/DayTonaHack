import type { DeployEvent, DeploymentRecord } from "./store";

type Listener = (event: DeployEvent, record: DeploymentRecord) => void;

type Bus = {
  listeners: Map<string, Set<Listener>>;
};

const globalBus = globalThis as typeof globalThis & { __hoistBus?: Bus };

function bus(): Bus {
  if (!globalBus.__hoistBus) {
    globalBus.__hoistBus = { listeners: new Map() };
  }
  return globalBus.__hoistBus;
}

export function publish(id: string, event: DeployEvent, record: DeploymentRecord): void {
  const set = bus().listeners.get(id);
  if (!set) return;
  for (const listener of set) {
    listener(event, record);
  }
}

export function subscribe(id: string, listener: Listener): () => void {
  const listeners = bus().listeners;
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(id);
    }
  };
}
