export interface LinuxControlHelper {
  readonly pid: number;
  readonly mode?: string;
  readonly target: number;
  readonly action?: string | null;
}

export interface LinuxControlHelperViolation {
  readonly target: number;
  readonly children?: number;
  readonly helpers: LinuxControlHelper[];
}

export interface LinuxControlHelperCensus {
  readonly admission: number;
  readonly release: number;
  readonly handoffs: number;
  readonly violations: LinuxControlHelperViolation[];
}

export function controlHelperCensus(
  helpers: readonly LinuxControlHelper[],
  guardianChildCount: (guardian: number) => number,
): LinuxControlHelperCensus;
