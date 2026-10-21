/** Exact approved shell commands must not import extra code from shell startup variables. */
export function processEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (["BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS"].includes(key) || key.startsWith("BASH_FUNC_"))
      delete environment[key];
  }
  return environment;
}
