const { execSync } = require('child_process');

function getSecret(serviceName) {
  try {
    return execSync(
      `security find-generic-password -s "${serviceName}" -w`,
      { stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString().trim();
  } catch {
    throw new Error(
      `Keychain secret "${serviceName}" not found. ` +
      `Run: security add-generic-password -s "${serviceName}" -w <value>`
    );
  }
}

module.exports = { getSecret };
