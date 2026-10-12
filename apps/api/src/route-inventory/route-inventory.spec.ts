import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { discoverRoutes, type DiscoveredRoute } from './discover-routes';
import { ROUTE_INVENTORY, type RouteScope } from './route-inventory';

// Security 4B — the route inventory is enforced: every route the real
// AppModule registers must be classified in route-inventory.ts, and every
// classification must still name a real route. The structural checks below
// are guardrails on the classification (e.g. an Admin route must sit behind
// the Admin guards); they do not replace the runtime authorization tests.
describe('API route inventory', () => {
  let moduleRef: TestingModule;
  let routes: DiscoveredRoute[];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    routes = discoverRoutes(moduleRef);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const scopeOf = (route: DiscoveredRoute): RouteScope | undefined =>
    ROUTE_INVENTORY[route.key]?.scope;
  const isAdmin = (route: DiscoveredRoute) =>
    route.path.startsWith('/api/v1/admin/');

  it('discovers the application routes', () => {
    // A sanity floor so a broken discovery can never pass vacuously.
    expect(routes.length).toBeGreaterThan(150);
  });

  it('registers no route twice', () => {
    const keys = routes.map((r) => r.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('classifies every registered route', () => {
    const unclassified = routes
      .filter((r) => !scopeOf(r))
      .map((r) => `${r.key}  (${r.controller}.${r.handler})`);
    // Add each of these to apps/api/src/route-inventory/route-inventory.ts
    // with the scope its runtime authorization actually enforces.
    expect(unclassified).toEqual([]);
  });

  it('lists no route that no longer exists', () => {
    const registered = new Set(routes.map((r) => r.key));
    expect(
      Object.keys(ROUTE_INVENTORY).filter((key) => !registered.has(key)),
    ).toEqual([]);
  });

  it('Admin routes are tenant-, location- or platform-scoped and sit behind the Admin guards', () => {
    const violations = routes
      .filter(isAdmin)
      .filter(
        (r) =>
          !['tenant', 'location', 'platform'].includes(scopeOf(r) ?? '') ||
          !r.guards.includes('InternalAuthGuard') ||
          !r.guards.includes('PermissionGuard'),
      )
      .map((r) => `${r.key} [${scopeOf(r)}] guards=${r.guards.join(',')}`);
    expect(violations).toEqual([]);
  });

  it('location and platform scopes are only used on guarded internal routes', () => {
    const violations = routes
      .filter((r) => ['location', 'platform'].includes(scopeOf(r) ?? ''))
      .filter((r) => !isAdmin(r) || !r.guards.includes('InternalAuthGuard'))
      .map((r) => r.key);
    expect(violations).toEqual([]);
  });

  it('public-auth, token and system routes never expose Admin paths', () => {
    expect(
      routes
        .filter((r) =>
          ['public-auth', 'token', 'system'].includes(scopeOf(r) ?? ''),
        )
        .filter(isAdmin)
        .map((r) => r.key),
    ).toEqual([]);
  });

  it("the customer's own routes require the customer guard", () => {
    expect(
      routes
        .filter((r) => r.path.startsWith('/api/v1/customers/me'))
        .filter((r) => !r.guards.includes('CustomerAuthGuard'))
        .map((r) => r.key),
    ).toEqual([]);
  });
});
