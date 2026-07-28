export function gitProcessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    LANG: "C",
    LC_ALL: "C",
  };
}
