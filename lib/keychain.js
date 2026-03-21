const { execSync } = require('child_process');

const ENV_VAR_MAP = {
  'coachcarter-anthropic': 'ANTHROPIC_API_KEY',
  'coachcarter-garmin':    'GARMIN_PASSWORD',
  'coachcarter-gmail':     'GMAIL_APP_PASSWORD',
  'coachcarter-supabase':  'SUPABASE_SERVICE_KEY',
};

function getSecret(serviceName) {
  const envVar = ENV_VAR_MAP[serviceName];
  if (envVar && process.env[envVar]) return process.env[envVar];

  try {
    return execSync(
      `security find-generic-password -s "${serviceName}" -w`,
      { stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
  } catch {
    throw new Error(
      `Secret "${serviceName}" not found. ` +
      (envVar ? `Set env var ${envVar} or run: ` : 'Run: ') +
      `security add-generic-password -s "${serviceName}" -w <value>`
    );
  }
}

module.exports = { getSecret };
