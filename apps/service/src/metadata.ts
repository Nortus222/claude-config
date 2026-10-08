import { Effect } from 'effect';
import { ServiceFailure } from './errors.ts';
import type { ServiceOptions } from './service.ts';
import { setupRoute } from './setups.ts';
import { revisionRoute } from './revisions.ts';
import { syncRoute } from './sync.ts';
import { decisionRoute } from './decisions.ts';
import { statusRoute } from './status.ts';
import { accountRoute } from './account.ts';
export function metadataHandler(now: () => number, pollAfter: number): NonNullable<ServiceOptions['metadata']> {
  return (request,principal,store) => Effect.gen(function* () {
    for (const route of [setupRoute(request,principal,store,now),revisionRoute(request,principal,store,now),syncRoute(request,principal,store,pollAfter),decisionRoute(request,principal,store,now),statusRoute(request,principal,store),accountRoute(request,principal,store)]) {
      const response = yield* route;
      if (response) return response;
    }
    return yield* Effect.fail(new ServiceFailure({ code:'not_found' }));
  });
}
