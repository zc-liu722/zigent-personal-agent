import type { ModelFailureKind } from "./errors.js";

/** Safe, structured failure metadata; never retain upstream response bodies. */
export type SupplierFailure = { kind: ModelFailureKind; status?: number };

/** Agent-local supplier health shared by text and image model gateways. */
export class SupplierHealthRegistry {
  private readonly circuits = new Map<string, { until: number; failure?: SupplierFailure }>();

  isOpen(supplier: string, now = Date.now()): boolean {
    const openUntil = this.circuits.get(supplier)?.until ?? 0;
    if (openUntil <= now) {
      if (openUntil > 0) this.circuits.delete(supplier);
      return false;
    }
    return true;
  }

  failure(supplier: string, now = Date.now()): SupplierFailure | undefined {
    return this.isOpen(supplier, now) ? this.circuits.get(supplier)?.failure : undefined;
  }

  markFailure(supplier: string, circuitBreakerMs: number, now = Date.now(), failure?: SupplierFailure): void {
    this.circuits.set(supplier, { until: now + circuitBreakerMs, failure });
  }

  markSuccess(supplier: string): void {
    this.circuits.delete(supplier);
  }

  reset(supplier?: string): void {
    if (supplier) this.circuits.delete(supplier);
    else this.circuits.clear();
  }
}
