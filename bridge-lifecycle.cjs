const http = require('node:http');

function readHealth(url) {
  return new Promise(resolve => {
    const request = http.get(url + 'api/health', response => {
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 8192) request.destroy();
      });
      response.on('error', () => resolve(null));
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); }
        catch { resolve(null); }
      });
    });
    request.setTimeout(500, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

function matches(health, version) {
  return health?.app === 'digital-terrarium' && health.telemetryVersion === 1 && health.version === version;
}

async function ensureBridge({ version, health, replace, start, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const current = await health();
  if (matches(current, version)) return;
  if (current) {
    if (current.app !== 'digital-terrarium') throw new Error('Bridge address belongs to another application');
    console.log(`[terrarium bridge] replacing ${current.version || 'unversioned'} with ${version}`);
    await replace();
  } else {
    await start();
  }
  for (let attempt = 0; attempt < 80; attempt++) {
    await delay(100);
    if (matches(await health(), version)) return;
  }
  throw new Error(`Bridge did not become ready with version ${version}; rebuild bin/digital-terrarium and check terrarium-mood.service`);
}

module.exports = { readHealth, matches, ensureBridge };
