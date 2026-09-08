import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** A generic post-verification result. Domain-specific receipts belong in data. */
export const FinalizationResult = Type.Object({
  outcome: Type.Union([
    Type.Literal("success"),
    Type.Literal("blocked"),
    Type.Literal("failure"),
  ]),
  summary: Type.String({ minLength: 1 }),
  artifacts: Type.Optional(Type.Array(Type.String())),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type FinalizationResultT = Static<typeof FinalizationResult>;

export function parseFinalizationResult(value: unknown): FinalizationResultT {
  if (!Value.Check(FinalizationResult, value)) {
    throw new Error(
      "finalizer must report an outcome and summary using the requested schema",
    );
  }
  return value;
}
