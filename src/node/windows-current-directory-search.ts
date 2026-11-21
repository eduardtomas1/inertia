export const WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY = "NoDefaultCurrentDirectoryInExePath";

const NORMALIZED_KEY = WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY.toUpperCase();

let recordedUserSetting: { value: string | undefined } | undefined;

function settingKeys(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter((key) => key.toUpperCase() === NORMALIZED_KEY);
}

export function windowsCurrentDirectorySearchSetting(environment: NodeJS.ProcessEnv): string | undefined {
  const keys = settingKeys(environment);
  const key = keys.includes(WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY) ? WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY : keys[0];
  return key === undefined ? undefined : environment[key];
}

export function withoutWindowsCurrentDirectorySearch(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return environment;
  for (const key of settingKeys(environment)) {
    if (key !== WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY) delete environment[key];
  }
  environment[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY] = "1";
  return environment;
}

export function guardProcessAgainstWindowsCurrentDirectorySearch(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  recordedUserSetting ??= { value: windowsCurrentDirectorySearchSetting(environment) };
  withoutWindowsCurrentDirectorySearch(environment, platform);
}

export function userWindowsCurrentDirectorySearch(): string | undefined {
  return recordedUserSetting ? recordedUserSetting.value : windowsCurrentDirectorySearchSetting(process.env);
}

export function withUserWindowsCurrentDirectorySearch(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  userSetting: string | undefined = userWindowsCurrentDirectorySearch(),
): NodeJS.ProcessEnv {
  if (platform !== "win32") return environment;
  const restored = { ...environment };
  for (const key of settingKeys(restored)) delete restored[key];
  if (userSetting !== undefined) restored[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY] = userSetting;
  return restored;
}
