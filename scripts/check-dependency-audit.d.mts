export interface AuditAdvisory {
  id: string;
  package: string;
  severity: string;
  title: string;
}

export interface DependencyAuditException {
  advisory: string;
  package: string;
  reason: string;
  expires: string;
  expired: boolean;
}

export interface DependencyAuditResult {
  failures: string[];
  accepted: string[];
  unused: string[];
}

export function auditAdvisories(report: unknown): AuditAdvisory[];
export function validateExceptions(document: unknown, today: string): DependencyAuditException[];
export function evaluateDependencyAudit(input: {
  fullReport: unknown;
  productionReport: unknown;
  exceptions: unknown;
  today: string;
}): DependencyAuditResult;
