import { governed } from "./errors.mjs";

/** Deliberately far below OpenTable's published online-booking ceiling. */
export class BoundedRateLimiter {
  constructor({ now = () => new Date(), readLimit = 24, readWindowMs = 30_000, mutationLimit = 4, mutationWindowMs = 60_000 } = {}) {
    this.now = now;
    this.readLimit = readLimit;
    this.readWindowMs = readWindowMs;
    this.mutationLimit = mutationLimit;
    this.mutationWindowMs = mutationWindowMs;
    this.reads = [];
    this.mutations = [];
  }

  acquire(kind) {
    const at = this.timestamp();
    prune(this.reads, at - this.readWindowMs);
    prune(this.mutations, at - this.mutationWindowMs);
    if (this.reads.length >= this.readLimit) throw governed("local_rate_limit", "Rico's local OpenTable read limit was reached. Try again shortly.", { retryable: true });
    if (kind === "mutation" && this.mutations.length >= this.mutationLimit) throw governed("local_mutation_rate_limit", "Rico's local OpenTable mutation limit was reached. No action was sent.", { retryable: true });
    this.reads.push(at);
    if (kind === "mutation") this.mutations.push(at);
  }

  timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The OpenTable rate-limit clock is invalid.");
    return date.getTime();
  }
}

function prune(values, cutoff) {
  while (values.length && values[0] <= cutoff) values.shift();
}
