// Environment variables that hold secrets. The Copilot runtime gets its token another way,
// and the browser tools and the model never need any of them.
export const SECRET_ENV_VARS = ['COPILOT_GITHUB_TOKEN', 'COPILOT_SDK_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

// Secrets that belong to this app rather than to whoever runs it.
const APP_SECRET_ENV_VARS = ['COPILOT_GITHUB_TOKEN'];

export function withoutAppSecrets(env = process.env) {
  const copy = { ...env };
  for (const name of APP_SECRET_ENV_VARS) delete copy[name];
  return copy;
}
