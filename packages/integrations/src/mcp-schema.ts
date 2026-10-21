const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_NODES = 1024;
const MAX_SCHEMA_DEPTH = 32;
const SUPPORTED_KEYWORDS = new Set([
  "$id",
  "$schema",
  "$ref",
  "$comment",
  "$defs",
  "definitions",
  "$anchor",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
  "x-mcp-header",
  "type",
  "nullable",
  "enum",
  "const",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "dependencies",
  "minProperties",
  "maxProperties",
  "items",
  "additionalItems",
  "contains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "contentEncoding",
  "contentMediaType",
]);

/** Conservative external-schema subset: bounded trees, acyclic local refs, no host regex execution. */
export function validateMcpInputSchema(schema: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES)
    throw new Error("input schema exceeds 65536 bytes");
  const active = new Set<object>();
  let nodes = 0;
  const localReference = (reference: unknown): unknown => {
    if (typeof reference !== "string" || (reference !== "#" && !reference.startsWith("#/")))
      throw new Error("only local JSON-pointer schema references are supported");
    if (reference === "#") return schema;
    let target: unknown = schema;
    for (const key of decodeURIComponent(reference.slice(2)).split("/")) {
      const segment = key.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!target || typeof target !== "object" || !Object.hasOwn(target, segment))
        throw new Error("input schema reference does not exist");
      target = (target as Record<string, unknown>)[segment];
    }
    return target;
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_SCHEMA_DEPTH) throw new Error("input schema exceeds depth 32");
    if (typeof value === "boolean") return;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("input schema node must be an object or boolean");
    if (active.has(value)) throw new Error("recursive input schema references are unsupported");
    // Count every expanded reference, including repeated acyclic DAG edges, to bound validation work.
    if (++nodes > MAX_SCHEMA_NODES) throw new Error("input schema exceeds 1024 nodes");
    active.add(value);
    const node = value as Record<string, unknown>;
    if (
      Object.hasOwn(node, "pattern") ||
      Object.hasOwn(node, "patternProperties") ||
      Object.hasOwn(node, "format")
    )
      throw new Error(
        "regular-expression/format schema keywords are unsupported for external tools",
      );
    if (Object.hasOwn(node, "$recursiveRef") || Object.hasOwn(node, "$dynamicRef"))
      throw new Error("dynamic/recursive input schema references are unsupported");
    if (Object.keys(node).some((key) => !SUPPORTED_KEYWORDS.has(key)))
      throw new Error("input schema contains a keyword unsupported by the host validator");
    if (Object.hasOwn(node, "$ref")) visit(localReference(node.$ref), depth + 1);
    for (const key of ["$defs", "definitions", "properties", "dependentSchemas", "dependencies"]) {
      const map = node[key];
      if (map && typeof map === "object" && !Array.isArray(map))
        for (const child of Object.values(map)) {
          if (key === "dependencies" && Array.isArray(child)) continue;
          visit(child, depth + 1);
        }
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"])
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child, depth + 1);
    for (const key of [
      "items",
      "additionalItems",
      "additionalProperties",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "propertyNames",
      "unevaluatedProperties",
      "unevaluatedItems",
      "contentSchema",
    ]) {
      if (!Object.hasOwn(node, key)) continue;
      const children = key === "items" && Array.isArray(node[key]) ? node[key] : [node[key]];
      for (const child of children) visit(child, depth + 1);
    }
    active.delete(value);
  };
  visit(schema, 0);
}
