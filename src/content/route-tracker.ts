import { CHANNEL } from '../shared/types';

export function installRouteTracker(): void {
  let previous = location.href;
  const notify = () => {
    if (previous === location.href) return;
    previous = location.href;
    window.postMessage({ channel: CHANNEL, direction: 'route', pageUrl: previous }, location.origin);
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (...args: Parameters<History[typeof method]>) {
      const result = Reflect.apply(original, this, args);
      notify();
      return result;
    };
  }
  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
}
