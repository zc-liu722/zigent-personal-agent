import type { PerformanceStore } from './store.js';
import type { LatencyMetric } from './metrics.js';
/** Only explicitly listed async boundaries are wrapped; sync contracts remain intact. */
export function instrumentAsync<T extends object>(target: T, store: PerformanceStore, metric: LatencyMetric, methods: readonly string[]): T {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(Object.assign(Object.create(Object.getPrototypeOf(target)), target) as T, { get(_object, key) {
    const object = target;
    const value = Reflect.get(object, key, object);
    if (typeof value !== 'function') return value;
    if (!wrapped.has(key)) wrapped.set(key, methods.includes(String(key))
      ? (...args: unknown[]) => store.measure(metric, key === 'execute' ? (Reflect.get(target, 'names') as readonly string[]).includes(String(args[0])) ? String(args[0]) : 'unknown_tool' : String(key), async () => value.apply(object, args), undefined,
        result => key === 'execute' && result && typeof result === 'object' && (result.ok === false || result.isError === true || result.status === 'failed') ? 'error' : 'ok') : value.bind(object));
    return wrapped.get(key);
  } });
}
