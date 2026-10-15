import { installFetchInterceptor } from './fetch-interceptor';
import { installXhrInterceptor } from './xhr-interceptor';
import { installRouteTracker } from './route-tracker';
import { installRuntimeCommands } from './request-runtime';

const marker = Symbol.for('API_CACHE_REPLAY_MAIN_V1');
const runtime = window as unknown as Record<symbol, boolean>;
if (window === window.top && !runtime[marker]) {
  runtime[marker] = true;
  installRuntimeCommands();
  installRouteTracker();
  installFetchInterceptor();
  installXhrInterceptor();
}
