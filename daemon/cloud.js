'use strict';
// Read-only client for iRobot's cloud, used only for maps and mission
// history, which the robot never shares locally. The account password stays
// in the system keyring (GNOME Keyring via secret-tool); credentials from a
// login last about an hour and are kept in memory only.
//
// Flow (as the iRobot Home app does it): endpoint discovery -> Gigya
// accounts.login -> iRobot v2/login -> AWS SigV4-signed GETs.
// Only GET requests are ever sent to the authenticated API.

const crypto = require('crypto');
const { execFile } = require('child_process');

const DISCOVERY = 'https://disc-prod.iot.irobotapi.com/v1/discover/endpoints?country_code=';
const APP_ID = 'ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294';
const KEYRING = { service: 'sweep', attr: 'account' };

// ---------- AWS Signature Version 4 ----------
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();
// RFC 3986 encoding, as SigV4 requires.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function signRequest ({ method = 'GET', host, path, query = {}, region, service = 'execute-api', accessKey, secretKey, sessionToken, body = '', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&');
  const headers = { host, 'x-amz-date': amzDate };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalPath = path.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/');
  const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalQuery
  };
}

// ---------- keyring ----------
function keyringLookup (email) {
  return new Promise((resolve, reject) => {
    execFile('secret-tool', ['lookup', 'service', KEYRING.service, KEYRING.attr, email], { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout) return reject(new Error('no iRobot password in the keyring; run bin/sweep-cloud-login'));
      resolve(stdout.replace(/\n$/, ''));
    });
  });
}

function keyringStore (email, password) {
  return new Promise((resolve, reject) => {
    const p = execFile('secret-tool', ['store', '--label=Sweep: iRobot account', 'service', KEYRING.service, KEYRING.attr, email], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
    p.stdin.end(password);
  });
}

// ---------- client ----------
class CloudError extends Error {
  constructor (message, status) { super(message); this.status = status; }
}

class Cloud {
  constructor ({ email, country = 'US', log = console, getPassword = keyringLookup } = {}) {
    this.email = email;
    this.country = country;
    this.log = log;
    this.getPassword = getPassword;
    this.endpoints = null;
    this.endpointsAt = 0;
    this.creds = null; // {accessKey, secretKey, sessionToken, region, expires}
    this.robots = null;
    this.loggingIn = null;
    this.lastError = null;
    this.lastLoginAt = null;
  }

  status () {
    return { configured: !!this.email, email: this.email || null, loggedIn: !!this.creds && this.creds.expires > Date.now(), lastLoginAt: this.lastLoginAt, lastError: this.lastError };
  }

  async discover () {
    if (this.endpoints && Date.now() - this.endpointsAt < 3600000) return this.endpoints;
    const res = await fetch(DISCOVERY + encodeURIComponent(this.country));
    if (!res.ok) throw new CloudError(`discovery failed (HTTP ${res.status})`, res.status);
    const d = await res.json();
    const dep = (d.deployments && d.deployments[d.current_deployment]) || {};
    const gigya = d.gigya || {};
    if (!dep.httpBase || !dep.httpBaseAuth || !gigya.api_key) throw new CloudError('discovery response missing endpoints');
    this.endpoints = { httpBase: dep.httpBase, httpBaseAuth: dep.httpBaseAuth, gigyaBase: `https://accounts.${gigya.datacenter_domain || 'us1.gigya.com'}`, apiKey: gigya.api_key };
    this.endpointsAt = Date.now();
    return this.endpoints;
  }

  // One login at a time; reused for about an hour.
  login () {
    if (!this.loggingIn) this.loggingIn = this._login().finally(() => { this.loggingIn = null; });
    return this.loggingIn;
  }

  async _login () {
    if (!this.email) throw new CloudError('iRobot account not set up; run bin/sweep-cloud-login');
    const ep = await this.discover();
    const password = await this.getPassword(this.email);
    const form = new URLSearchParams({ apiKey: ep.apiKey, loginID: this.email, password, format: 'json', targetEnv: 'mobile' });
    const g = await (await fetch(`${ep.gigyaBase}/accounts.login`, { method: 'POST', body: form })).json();
    if (g.errorCode) {
      // 403041 = account temporarily locked; 403042 = wrong password. Never retry those automatically.
      const msg = g.errorCode === 403041 ? 'iRobot account temporarily locked; wait before trying again'
        : g.errorCode === 403042 ? 'iRobot login rejected (wrong email or password, error 403042)'
          : `iRobot account login failed (${g.errorCode}: ${g.errorMessage || 'unknown'})`;
      throw new CloudError(msg, 401);
    }
    const body = {
      app_id: APP_ID,
      assume_robot_ownership: '0',
      gigya: { signature: g.UIDSignature, timestamp: g.signatureTimestamp, uid: g.UID }
    };
    const res = await fetch(`${ep.httpBase}/v2/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const r = await res.json().catch(() => ({}));
    if (!res.ok || !r.credentials) throw new CloudError(`iRobot login failed (HTTP ${res.status}${r.errorMessage ? `: ${r.errorMessage}` : ''})`, res.status);
    const c = r.credentials;
    this.creds = {
      accessKey: c.AccessKeyId,
      secretKey: c.SecretKey,
      sessionToken: c.SessionToken,
      region: String(c.CognitoId || 'us-east-1:').split(':')[0] || 'us-east-1',
      // Log in again five minutes before the credentials expire.
      expires: (Date.parse(c.Expiration) || Date.now() + 3600000) - 300000
    };
    this.robots = Object.fromEntries(Object.entries(r.robots || {}).map(([blid, x]) => [blid, { name: x.name, sku: x.sku }]));
    this.lastLoginAt = Date.now();
    this.lastError = null;
    return this.robots;
  }

  async get (path, query = {}, { retried = false } = {}) {
    try {
      if (!this.creds || this.creds.expires < Date.now()) await this.login();
      const ep = await this.discover();
      const url = new URL(ep.httpBaseAuth);
      const fullPath = url.pathname.replace(/\/$/, '') + path;
      const h = signRequest({ host: url.host, path: fullPath, query, region: this.creds.region, accessKey: this.creds.accessKey, secretKey: this.creds.secretKey, sessionToken: this.creds.sessionToken });
      const { canonicalQuery, ...headers } = h;
      const res = await fetch(`${url.origin}${fullPath}${canonicalQuery ? `?${canonicalQuery}` : ''}`, { headers });
      if (res.status === 403 && !retried) { this.creds = null; return this.get(path, query, { retried: true }); }
      if (res.status === 429 && !retried) {
        const wait = Math.min(60, Number(res.headers.get('retry-after')) || 5);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        return this.get(path, query, { retried: true });
      }
      if (!res.ok) throw new CloudError(`cloud request failed (HTTP ${res.status}) for ${path}`, res.status);
      return res.json();
    } catch (e) {
      this.lastError = e.message;
      throw e;
    }
  }

  pmaps (blid) { return this.get(`/v1/${blid}/pmaps`, { visible: 'true', activeDetails: '2' }); }
  umf (blid, pmapId, versionId) { return this.get(`/v1/${blid}/pmaps/${pmapId}/versions/${versionId}/umf`, { activeDetails: '2' }); }
  missionHistory (blid, maxReports = 30) {
    return this.get(`/v1/${blid}/missionhistory`, { app_id: APP_ID, filterType: 'omit_quickly_canceled_not_scheduled', supportedDoneCodes: 'dndEnd,returnHomeEnd', maxReports: String(maxReports) });
  }
}

module.exports = { Cloud, CloudError, signRequest, keyringLookup, keyringStore };
