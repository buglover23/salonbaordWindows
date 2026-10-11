import { z, type ZodType } from 'zod';

type Node = Record<string, unknown>;

// Keywords OpenAI documents for strict structured outputs (developers.openai.com/api/docs/guides/structured-outputs).
// minLength/maxLength and const are not listed, so they are not sent as constraints: const becomes a one-value enum and
// the rest goes into the description as `{keyword: value}`, like the other providers' schemas. The answer is still
// parsed with the Zod schema.
const STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs',
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'description',
  'pattern',
  'format',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'minItems',
  'maxItems',
]);
const STRICT_FORMATS: ReadonlySet<string> = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);
// Dropping these would change which values are valid.
const UNREPRESENTABLE = ['allOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'prefixItems', 'patternProperties'] as const;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export interface OpenAiSchema {
  /** The `json_schema.schema` of a strict request. */
  schema: Node;
  /** Removes the nulls the model has to send for keys the Zod schema has as optional (strict mode requires every key). */
  normalize(value: unknown): unknown;
}

/** The same node accepting null as well (an optional key in strict mode). */
function nullable(n: Node, path: string): Node {
  if (typeof n.$ref === 'string') return { anyOf: [n, { type: 'null' }] };
  if (Array.isArray(n.anyOf)) return { ...n, anyOf: [...(n.anyOf as unknown[]), { type: 'null' }] };
  const withEnum = Array.isArray(n.enum) && !n.enum.includes(null) ? { enum: [...(n.enum as unknown[]), null] } : {};
  if (typeof n.type === 'string') return { ...n, type: [n.type, 'null'], ...withEnum };
  if (Array.isArray(n.type)) return { ...n, type: n.type.includes('null') ? n.type : [...(n.type as unknown[]), 'null'], ...withEnum };
  if (Array.isArray(n.enum)) return { ...n, ...withEnum };
  throw new Error(`${path} は型の無い省略可能な項目のため、OpenAI の構造化出力で表せません`);
}

function convert(n: unknown, path: string, optional: Map<Node, ReadonlySet<string>>): Node {
  if (!isNode(n)) throw new Error(`${path || '最上位'} が JSON Schema のオブジェクトではありません`);
  for (const key of UNREPRESENTABLE) {
    if (key in n) throw new Error(`${key}（${path || '最上位'}）は OpenAI の構造化出力で表せません`);
  }
  if (typeof n.$ref === 'string') return { $ref: n.$ref };
  const out: Node = {};
  const notes: string[] = [];
  const note = (key: string, value: unknown): void => {
    notes.push(`${key}: ${JSON.stringify(value)}`);
  };
  for (const [key, value] of Object.entries(n)) {
    if (key === '$schema') continue;
    if (key === 'const') {
      if (isPrimitive(value) && !('enum' in n)) out.enum = [value];
      else note(key, value);
    } else if (key === 'additionalProperties') {
      if (isNode(value)) throw new Error(`${path || '最上位'} は任意のキーを持つオブジェクト（record）のため、OpenAI の構造化出力で表せません`);
    } else if (key === 'properties' || key === '$defs') {
      if (!isNode(value)) throw new Error(`${path}.${key} が JSON Schema のオブジェクトではありません`);
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, convert(child, path === '' ? name : `${path}.${name}`, optional)]));
    } else if (key === 'anyOf' || key === 'oneOf') {
      // oneOf is not in the strict list; anyOf admits the same values here, and the Zod parse still checks the answer.
      out.anyOf = (Array.isArray(value) ? value : []).map((child, i) => convert(child, `${path}.${key}[${i}]`, optional));
    } else if (key === 'items') {
      out.items = convert(value, `${path}[]`, optional);
    } else if ((key === 'format' && !STRICT_FORMATS.has(String(value))) || !STRICT_KEYWORDS.has(key)) {
      note(key, value);
    } else {
      out[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
    }
  }
  if (out.type === 'object') {
    const properties = isNode(out.properties) ? out.properties : {};
    const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
    const optionalKeys = Object.keys(properties).filter((k) => !required.has(k));
    for (const k of optionalKeys) properties[k] = nullable(properties[k] as Node, path === '' ? k : `${path}.${k}`);
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
    if (optionalKeys.length > 0) optional.set(out, new Set(optionalKeys));
  }
  if (notes.length > 0) {
    const own = typeof out.description === 'string' ? out.description : undefined;
    out.description = [own, `{${notes.join(', ')}}`].filter((p) => p !== undefined).join('\n\n');
  }
  return out;
}

function resolveRef(n: Node, root: Node): Node {
  if (typeof n.$ref !== 'string') return n;
  if (n.$ref === '#') return root;
  const name = n.$ref.startsWith('#/$defs/') ? n.$ref.slice('#/$defs/'.length) : undefined;
  const defs = isNode(root.$defs) ? root.$defs : {};
  return name !== undefined && isNode(defs[name]) ? defs[name] : n;
}

function stripNulls(value: unknown, schema: Node, root: Node, optional: Map<Node, ReadonlySet<string>>, depth = 0): unknown {
  if (typeof value !== 'object' || value === null || depth > 64) return value;
  const n = resolveRef(schema, root);
  if (Array.isArray(value)) return isNode(n.items) ? value.map((v) => stripNulls(v, n.items as Node, root, optional, depth + 1)) : value;
  let out: unknown = value;
  for (const variant of Array.isArray(n.anyOf) ? n.anyOf.filter(isNode) : []) out = stripNulls(out, variant, root, optional, depth + 1);
  if (n.type !== 'object' || !isNode(out)) return out;
  const copy: Node = { ...out };
  for (const k of optional.get(n) ?? []) {
    if (copy[k] === null) delete copy[k];
  }
  const properties = isNode(n.properties) ? n.properties : {};
  for (const [k, child] of Object.entries(properties)) {
    if (k in copy && isNode(child)) copy[k] = stripNulls(copy[k], child, root, optional, depth + 1);
  }
  return copy;
}

/**
 * The JSON Schema for `response_format: {type: 'json_schema', strict: true}`: every object closed and every key
 * required (an optional key becomes required and null-able; `normalize` takes those nulls out again), primitive const as
 * a one-value enum, enums kept, keywords outside the strict list moved into descriptions. Throws when the schema cannot
 * be expressed (the root is not an object, records, allOf, …), before anything is sent.
 */
export function openAiStrictSchema(schema: ZodType): OpenAiSchema {
  const optional = new Map<Node, ReadonlySet<string>>();
  const root = convert(z.toJSONSchema(schema), '', optional);
  if (root.type !== 'object') throw new Error('最上位がオブジェクトではないため、OpenAI の構造化出力で表せません');
  return { schema: root, normalize: (value) => stripNulls(value, root, root, optional) };
}

/**
 * Appended to the system prompt when the server cannot be given a schema (json_object, none). JSON mode requires the
 * word "JSON" in the messages.
 */
export function jsonInstruction(schema: ZodType): string {
  const json: Node = { ...(z.toJSONSchema(schema) as Node) };
  delete json.$schema;
  return `Answer with exactly one JSON object and nothing else: no explanation, no Markdown, no code fence. The JSON object must match this JSON Schema:\n${JSON.stringify(json)}`;
}

/** The JSON object in a free-text answer: <think> blocks and ``` fences removed, from the first "{" to the last "}". */
export function extractJsonText(text: string): string | null {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /```[A-Za-z]*\s*([\s\S]*?)```/.exec(t);
  const body = (fenced?.[1] ?? t).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}
