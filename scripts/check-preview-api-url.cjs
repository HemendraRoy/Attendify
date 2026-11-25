const { isIP } = require('node:net');

if (process.argv.includes('--eas') && process.env.EAS_BUILD_PROFILE !== 'preview') {
  process.exit(0);
}

let url;
try {
  url = new URL(process.env.EXPO_PUBLIC_API_URL);
} catch {
  // The validation below also handles a missing or malformed URL.
}

const hostname = url?.hostname.replace(/\.$/, '');
if (
  url?.protocol !== 'https:' ||
  !hostname?.includes('.') ||
  isIP(hostname) !== 0 ||
  /\.(?:localhost|local)$/.test(hostname) ||
  url.username || url.password ||
  url.pathname !== '/' || url.search || url.hash
) {
  console.error('Set EXPO_PUBLIC_API_URL to the public HTTPS origin of the staging backend, without an API path.');
  process.exitCode = 1;
}
