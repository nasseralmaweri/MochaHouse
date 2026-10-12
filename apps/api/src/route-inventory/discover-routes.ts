import { RequestMethod, type Type } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

// Security 4B — every HTTP route the application actually registers, read
// from Nest's own controller metadata (the same metadata the router is
// built from), with the guards that apply to it (class + handler).
export interface DiscoveredRoute {
  key: string; // e.g. "GET /api/v1/admin/customers/:customerId"
  method: string;
  path: string;
  controller: string;
  handler: string;
  guards: string[];
}

function joinPath(...parts: Array<string | string[] | undefined>): string {
  const segments = parts
    .flatMap((part) => (Array.isArray(part) ? part[0] : part) ?? '')
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

function guardNames(target: object | undefined): string[] {
  const guards =
    (target
      ? (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined)
      : undefined) ?? [];
  return guards.map((guard) =>
    typeof guard === 'function'
      ? guard.name
      : (guard as object).constructor.name,
  );
}

export function discoverRoutes(
  app: INestApplicationContext,
): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const seen = new Set<Type<unknown>>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | null;
      if (!controller || seen.has(controller)) continue;
      seen.add(controller);
      const base = Reflect.getMetadata(PATH_METADATA, controller) as
        string | string[] | undefined;
      // Walk the prototype chain: concrete controllers may inherit their
      // handlers from a shared base class (e.g. the checklist controllers).
      const prototype = controller.prototype as Record<string, unknown>;
      const handlers = new Set<string>();
      for (
        let proto: object | null = prototype;
        proto && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto) as object | null
      ) {
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name !== 'constructor') handlers.add(name);
        }
      }
      for (const handler of handlers) {
        const fn = prototype[handler];
        if (typeof fn !== 'function') continue;
        const methodPath = Reflect.getMetadata(PATH_METADATA, fn) as
          string | string[] | undefined;
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, fn) as
          RequestMethod | undefined;
        if (methodPath === undefined || requestMethod === undefined) continue;
        const method = RequestMethod[requestMethod];
        const path = joinPath(base, methodPath);
        routes.push({
          key: `${method} ${path}`,
          method,
          path,
          controller: controller.name,
          handler,
          guards: [...guardNames(controller), ...guardNames(fn)],
        });
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}
