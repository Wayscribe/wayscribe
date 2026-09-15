// Types for measure-storage-checks.mjs, which runs under plain node and so is
// JavaScript, for the TypeScript test that imports it.

export declare const MEASUREMENT_SCHEMA_PREFIX: string;

export declare function vacuumStatement(
  options: readonly ("analyze" | "full")[],
  schema: string,
  tables: readonly string[]
): { sql: string; bindings: string[] };

export declare function expectCompleteSweep(
  sweep: {
    ran: boolean;
    journeysDeleted: number;
    batches: number;
    environmentsExamined: number;
    stoppedEarly: boolean;
  },
  expected: number
): void;
