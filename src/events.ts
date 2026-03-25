import type { EventMap, CommandMiddleware, EventMiddleware } from "./types.js";

type EventHandler<K extends keyof EventMap> = EventMap[K] extends void
  ? () => void
  : (payload: EventMap[K]) => void;

export type { EventHandler };

/**
 * Compose a chain of middlewares around a base handler.
 * Rightmost middleware wraps the base first.
 */
export function buildCommandChain(
  middlewares: CommandMiddleware[],
  base: (cmd: string) => Promise<void>,
): (cmd: string) => Promise<void> {
  let handler = base;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    handler = middlewares[i]!(handler);
  }
  return handler;
}

export function buildEventChain(
  middlewares: EventMiddleware[],
  base: (evt: EventMap[keyof EventMap]) => void,
): (evt: EventMap[keyof EventMap]) => void {
  let handler = base;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    handler = middlewares[i]!(handler);
  }
  return handler;
}
