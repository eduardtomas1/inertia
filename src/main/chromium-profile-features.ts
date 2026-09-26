export const SHUTDOWN_BLOCKING_PROFILE_FEATURES = Object.freeze([
  "DIPS",
  "DeclarativePerformanceObserver",
]);

export function withShutdownBlockingProfileFeaturesDisabled(disabledFeatures: string): string {
  const features = disabledFeatures.split(",").map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
  for (const feature of SHUTDOWN_BLOCKING_PROFILE_FEATURES) {
    if (!features.includes(feature)) features.push(feature);
  }
  return features.join(",");
}

export function disableShutdownBlockingProfileFeatures(commandLine: {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value: string): void;
}): void {
  commandLine.appendSwitch(
    "disable-features",
    withShutdownBlockingProfileFeaturesDisabled(commandLine.getSwitchValue("disable-features")),
  );
}
