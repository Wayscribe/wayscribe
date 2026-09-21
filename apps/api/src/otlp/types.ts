/** Absence is distinct from an explicitly present empty AnyValue. Multiple
 * members deliberately survive decoding for the mapper's per-record refusal. */
export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: bigint;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
  bytesValue?: Buffer;
}
export interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}
export interface OtlpResource {
  attributes: OtlpKeyValue[];
  droppedAttributesCount?: number;
  entityRefs: { schemaUrl?: string; type?: string; idKeys: string[]; descriptionKeys: string[] }[];
}
export interface OtlpScope {
  name?: string;
  version?: string;
  attributes: OtlpKeyValue[];
  droppedAttributesCount?: number;
}
export interface OtlpLogRecord {
  timeUnixNano?: bigint;
  observedTimeUnixNano?: bigint;
  severityNumber?: number;
  severityText?: string;
  body?: OtlpAnyValue;
  attributes: OtlpKeyValue[];
  droppedAttributesCount?: number;
  flags?: number;
  traceId?: Buffer;
  spanId?: Buffer;
  eventName?: string;
}
export interface OtlpScopeLogs {
  scope?: OtlpScope;
  logRecords: OtlpLogRecord[];
  schemaUrl?: string;
}
export interface OtlpResourceLogs {
  resource?: OtlpResource;
  scopeLogs: OtlpScopeLogs[];
  schemaUrl?: string;
}
export interface DecodedExport {
  resourceLogs: OtlpResourceLogs[];
  recordCount: number;
}
export type OtlpEncoding = "json" | "protobuf";
