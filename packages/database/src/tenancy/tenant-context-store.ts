import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantContextError, type TenantContext } from './tenant-context';

// An async-scoped CARRIER for the current TenantContext, so infrastructure
// that cannot receive it as a parameter (the Prisma query audit, structured
// logs) can still correlate work with the tenant and request that caused it.
//
// It is NOT a tenant source. Nothing may read the tenant id from here in
// order to decide which tenant's data to query — business code receives
// TenantContext explicitly (the same way it receives AuthorizationContext
// today) and puts the tenant predicate in its own queries. The store only
// ever holds a context some server-side resolver already established.
const store = new AsyncLocalStorage<TenantContext>();

// Runs `fn` with `context` as the current TenantContext. Re-entering the
// SAME tenant is allowed (e.g. a nested helper re-establishing its own
// request id); entering a DIFFERENT tenant from inside one is refused —
// there is no legitimate code path that should silently cross tenants.
export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  const current = store.getStore();
  if (current && current.tenantId !== context.tenantId) {
    throw new TenantContextError(
      'Refusing to enter a different tenant from inside an existing tenant context.',
    );
  }
  return store.run(context, fn);
}

// Note for Prisma queries: they are lazy thenables that execute when
// awaited, so the context observed by the query audit is the one current at
// the AWAIT, not where the query object was built. Await inside the run
// (every async service method naturally does).
export function getCurrentTenantContext(): TenantContext | undefined {
  return store.getStore();
}
