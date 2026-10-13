export const stringSchema = { type: "string" };
export const lineNumberSchema = { type: "integer", minimum: 1 };

export function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}
