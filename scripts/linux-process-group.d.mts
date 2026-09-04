export interface LinuxProcessObservationDependencies {
  readonly readStat?: (pid: string) => string;
}

export interface LinuxProcessGroupObservationDependencies
  extends LinuxProcessObservationDependencies {
  readonly processIds?: () => string[];
}

export function linuxProcessCanExecute(
  pid: number,
  dependencies?: LinuxProcessObservationDependencies,
): boolean | null;

export function linuxProcessGroupCanExecute(
  processGroupId: number,
  dependencies?: LinuxProcessGroupObservationDependencies,
): boolean | null;
