import { Type } from "typebox";

/** `{ type: "string", enum }`: providers such as Google reject the `anyOf` of a literal union. */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
