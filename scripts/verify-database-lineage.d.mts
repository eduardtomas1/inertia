export interface DatabaseLineageEntry {
  version: number;
  name: string;
  digest: string;
  sources?: Array<{
    path: string;
    symbols: string[];
    digest: string;
  }>;
}

export interface DatabaseLineage {
  format: 2;
  migrations: DatabaseLineageEntry[];
}

export function parseLineage(source: string, label: string): DatabaseLineage;
export function validateLineageExtension(
  base: DatabaseLineage,
  current: DatabaseLineage,
): void;
