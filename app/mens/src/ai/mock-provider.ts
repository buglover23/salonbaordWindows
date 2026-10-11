import { z, type ZodType } from 'zod';
import { systemClock, type Clock } from '../shared/clock.js';
import { AppFailure, appError, type ErrorCode } from '../shared/errors.js';
import { sha256Hex } from '../shared/hash.js';
import type { AiStage } from '../shared/types.js';
import { validateOutput } from './output.js';
import { ZERO_USAGE, type AiContent, type AiProvider, type AiRequest, type AiResult } from './provider.js';

export interface MockFailure {
  code: ErrorCode;
  /** The first `times` matching calls fail; later ones succeed. */
  times: number;
  /** Only calls of these stages fail (and count); all stages when omitted. */
  stages?: readonly AiStage[];
  /** Defaults to the code's usual retryability. */
  retryable?: boolean;
  /** Extra error details (e.g. a provider's reason, attempts and resume_at). */
  details?: Record<string, unknown>;
}

/** Produces a stage's raw output; it is still checked against the request's schema like a real response. */
export type MockResponder = (req: AiRequest<unknown>) => unknown;

export interface MockProviderOptions {
  fail?: MockFailure;
  /** Output for a stage instead of the schema-derived value; wins over a default responder (setDefaultResponder). */
  responders?: Partial<Record<AiStage, MockResponder>>;
  /** Tests only: keep the last MAX_RECORDED_CALLS requests in `calls` (image data is never kept). Off by default. */
  record?: boolean;
  clock?: Clock;
}

/** A recorded request part: text as sent, an image only as its decoded size. */
export type RecordedContent = { type: 'text'; text: string } | { type: 'image_jpeg_base64'; bytes: number };

export interface MockCall {
  stage: AiStage;
  seed: string | undefined;
  system: string;
  content: RecordedContent[];
  maxTokens: number;
}

/** The mock is the provider of a long-running dry-run, so even when recording, only this many calls are kept. */
export const MAX_RECORDED_CALLS = 50;

const recorded = (c: AiContent): RecordedContent =>
  c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image_jpeg_base64', bytes: Buffer.byteLength(c.data, 'base64') };

type JsonSchema = Record<string, unknown>;

const MAX_DEPTH = 24;
const SPAN = 100;

const isObject = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

class Generator {
  readonly #root: JsonSchema;
  readonly #seed: string;
  readonly #stage: AiStage;

  constructor(root: JsonSchema, seed: string, stage: AiStage) {
    this.#root = root;
    this.#seed = seed;
    this.#stage = stage;
  }

  value(node: unknown, path: string[], depth: number): unknown {
    if (!isObject(node) || depth > MAX_DEPTH) return null;
    const ref = node.$ref;
    if (typeof ref === 'string') return this.value(this.#resolve(ref), path, depth + 1);
    if ('const' in node) return node.const;
    if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[Math.floor(this.#random(path) * node.enum.length)];
    const variants = (Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined) as unknown[] | undefined;
    if (variants !== undefined) {
      const pick = variants.find((v) => !(isObject(v) && v.type === 'null')) ?? variants[0];
      return this.value(pick, path, depth + 1);
    }
    if (Array.isArray(node.allOf) && node.allOf.length > 0) return this.value(node.allOf[0], path, depth + 1);

    const types = Array.isArray(node.type) ? (node.type as unknown[]) : [node.type];
    const type = types.find((t) => t !== 'null') ?? types[0];
    switch (type) {
      case 'object':
        return this.#object(node, path, depth);
      case 'array':
        return this.#array(node, path, depth);
      case 'string':
        return this.#string(node, path);
      case 'integer':
        return this.#integer(node, path);
      case 'number':
        return this.#number(node, path);
      case 'boolean':
        return this.#random(path) < 0.5;
      default:
        return null;
    }
  }

  #resolve(ref: string): unknown {
    if (ref === '#') return this.#root;
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    const defs = m ? this.#root[m[1] as string] : undefined;
    return m && isObject(defs) ? defs[m[2] as string] : undefined;
  }

  #hex(path: string[]): string {
    return sha256Hex(`${this.#seed}\u0000${this.#stage}\u0000${path.join('.')}`);
  }

  /** A number in [0, 1) fixed by the seed, the stage and the position in the output. */
  #random(path: string[]): number {
    return Number.parseInt(this.#hex(path).slice(0, 8), 16) / 0x1_0000_0000;
  }

  #object(node: JsonSchema, path: string[], depth: number): unknown {
    const props = isObject(node.properties) ? node.properties : {};
    return Object.fromEntries(Object.entries(props).map(([key, schema]) => [key, this.value(schema, [...path, key], depth + 1)]));
  }

  #array(node: JsonSchema, path: string[], depth: number): unknown[] {
    if (Array.isArray(node.prefixItems)) return node.prefixItems.map((schema, i) => this.value(schema, [...path, String(i)], depth + 1));
    const n = Math.min(Math.max(2, num(node.minItems) ?? 0), num(node.maxItems) ?? Number.POSITIVE_INFINITY);
    return Array.from({ length: n }, (_, i) => this.value(node.items, [...path, String(i)], depth + 1));
  }

  #string(node: JsonSchema, path: string[]): string {
    const hex = this.#hex(path);
    switch (node.format) {
      case 'date':
        return '2026-01-01';
      case 'date-time':
        return '2026-01-01T00:00:00Z';
      case 'time':
        return '00:00:00';
      case 'email':
        return `mock-${hex.slice(0, 6)}@example.com`;
      case 'uri':
      case 'url':
        return `https://example.com/mock-${hex.slice(0, 6)}`;
      case 'uuid':
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      default:
        break;
    }
    const label = [...path].reverse().find((p) => !/^\d+$/.test(p)) ?? 'value';
    let text = `模擬-${label}-${hex.slice(0, 6)}`;
    const max = num(node.maxLength);
    const min = num(node.minLength) ?? 0;
    if (max !== undefined && text.length > max) text = text.slice(0, max);
    if (text.length < min) text = text.padEnd(min, 'x');
    return text;
  }

  // Bounds default to a span of 100; huge spans (Zod's safe-integer limits) are narrowed to 100 near zero.
  #range(node: JsonSchema, step: number): [number, number] {
    const exMin = num(node.exclusiveMinimum);
    const exMax = num(node.exclusiveMaximum);
    let lo = num(node.minimum) ?? (exMin === undefined ? undefined : exMin + step);
    let hi = num(node.maximum) ?? (exMax === undefined ? undefined : exMax - step);
    if (lo === undefined && hi === undefined) [lo, hi] = [0, SPAN];
    else if (lo === undefined) lo = (hi as number) - SPAN;
    else if (hi === undefined) hi = lo + SPAN;
    let [a, b] = [lo, hi as number];
    if (b - a > SPAN) {
      if (a <= 0 && b >= SPAN) [a, b] = [0, SPAN];
      else if (a > 0) b = a + SPAN;
      else a = b - SPAN;
    }
    return [a, b];
  }

  // The top of the range: a mock confidence is "sure" (0.9+), so dry-run never stops as uncertain.
  #integer(node: JsonSchema, path: string[]): number {
    const [lo, hi] = this.#range(node, 1);
    const top = Math.floor(hi);
    const start = Math.max(Math.ceil(lo), top - 10);
    return top - Math.floor(this.#random(path) * (top - start + 1));
  }

  #number(node: JsonSchema, path: string[]): number {
    const exclusive = num(node.exclusiveMinimum) !== undefined || num(node.exclusiveMaximum) !== undefined;
    const [lo, hi] = exclusive ? [num(node.exclusiveMinimum) ?? num(node.minimum) ?? 0, num(node.exclusiveMaximum) ?? num(node.maximum) ?? SPAN] : this.#range(node, 0);
    if (hi <= lo) return lo;
    return Math.round((lo + (hi - lo) * (0.9 + 0.09 * this.#random(path))) * 1000) / 1000;
  }
}

/**
 * A value for `schema` decided only by `seed` and `stage` (the same job always gets the same output): enums and
 * booleans picked by hash, numbers near the top of their range, strings labelled 模擬-<field>-<hash>. Patterns and custom
 * refinements are not followed; the caller validates the value.
 */
export function mockValueFor(schema: ZodType, seed: string, stage: AiStage): unknown {
  const root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  return new Generator(root, seed, stage).value(root, [], 0);
}

/**
 * The no-cost provider for dry-run and tests (Plan 2 decision 2): no network, zero usage, output derived from the job id
 * (`seed`) or from a per-stage responder, always checked against the request's schema like a real response.
 */
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  /** With `record: true`, the last MAX_RECORDED_CALLS requests, oldest first (tests assert prompts with it); else empty. */
  readonly calls: MockCall[] = [];
  readonly #o: MockProviderOptions;
  readonly #clock: Clock;
  readonly #defaults = new Map<AiStage, MockResponder>();
  #failed = 0;

  constructor(o: MockProviderOptions = {}) {
    this.#o = o;
    this.#clock = o.clock ?? systemClock;
  }

  /**
   * A stage's output when the options name no responder for it (realistic dry-run output, see mock-responders.ts);
   * replaces an earlier default for the same stage.
   */
  setDefaultResponder(stage: AiStage, responder: MockResponder): void {
    this.#defaults.set(stage, responder);
  }

  async structured<T>(req: AiRequest<T>): Promise<AiResult<T>> {
    if (this.#o.record === true) {
      this.calls.push({ stage: req.stage, seed: req.seed, system: req.system, content: req.content.map(recorded), maxTokens: req.maxTokens });
      if (this.calls.length > MAX_RECORDED_CALLS) this.calls.splice(0, this.calls.length - MAX_RECORDED_CALLS);
    }
    const fail = this.#o.fail;
    if (fail !== undefined && this.#failed < fail.times && (fail.stages === undefined || fail.stages.includes(req.stage))) {
      this.#failed++;
      throw new AppFailure(
        appError(fail.code, 'ai', this.#clock, {
          ...(fail.retryable === undefined ? {} : { retryable: fail.retryable }),
          details: { provider: 'mock', stage: req.stage, injected_failure: this.#failed, ...fail.details },
        }),
      );
    }
    // A web search has its own output shape: never a stage's draft responder (the schema-derived value instead).
    const responder = req.webSearch === true ? undefined : (this.#o.responders?.[req.stage] ?? this.#defaults.get(req.stage));
    const raw = responder === undefined ? mockValueFor(req.schema, req.seed ?? '', req.stage) : await responder(req as AiRequest<unknown>);
    const value = validateOutput(req.schema, raw, this.#clock, { provider: 'mock', stage: req.stage });
    return { value, usage: { ...ZERO_USAGE }, model: 'mock' };
  }
}
