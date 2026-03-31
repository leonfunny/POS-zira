/**
 * Simple typed service container
 *
 * No decorators, no reflection, no external DI framework.
 * Just a typed Map with lazy factory support.
 */

import type { ServiceToken } from './tokens';

type Factory<T> = () => T;

export class ServiceContainer {
  private instances = new Map<string, unknown>();
  private factories = new Map<string, Factory<unknown>>();

  /**
   * Register a ready-made instance.
   */
  set<T>(token: ServiceToken, instance: T): void {
    this.instances.set(token, instance);
  }

  /**
   * Register a lazy factory. The factory is called once on first `get()`.
   */
  factory<T>(token: ServiceToken, fn: Factory<T>): void {
    this.factories.set(token, fn as Factory<unknown>);
  }

  /**
   * Retrieve a service. Throws if not registered.
   */
  get<T>(token: ServiceToken): T {
    // Already instantiated?
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    // Has factory? Create, cache, return.
    const factory = this.factories.get(token);
    if (factory) {
      const instance = factory();
      this.instances.set(token, instance);
      this.factories.delete(token);
      return instance as T;
    }

    throw new Error(`[ServiceContainer] No service registered for token "${token}"`);
  }

  /**
   * Retrieve a service or return undefined if not registered.
   */
  getOptional<T>(token: ServiceToken): T | undefined {
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    const factory = this.factories.get(token);
    if (factory) {
      const instance = factory();
      this.instances.set(token, instance);
      this.factories.delete(token);
      return instance as T;
    }

    return undefined;
  }

  /**
   * Check if a service is registered (instance or factory).
   */
  has(token: ServiceToken): boolean {
    return this.instances.has(token) || this.factories.has(token);
  }

  /**
   * Remove a service registration.
   */
  remove(token: ServiceToken): void {
    this.instances.delete(token);
    this.factories.delete(token);
  }

  /**
   * Clear all registrations.
   */
  clear(): void {
    this.instances.clear();
    this.factories.clear();
  }
}
