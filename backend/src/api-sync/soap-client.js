/**
 * Calls a HIS ASMX/SOAP method and returns its rows.
 *
 * The HIS service does not answer like a textbook SOAP service: it writes the
 * JSON straight into the response body and THEN an empty SOAP envelope —
 *
 *   {"Total":"242","IPcollectionv":[ … ]}<?xml …><soap:Envelope>…<IpCollectionResponse/>…
 *
 * so the JSON is taken from before the XML. A well-behaved service that puts
 * the JSON inside <MethodResult> is read too.
 *
 * node's https (not fetch) so a config can accept the hospital's self-signed
 * certificate (tls_insecure) without turning certificate checks off globally.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_BODY_BYTES = 50 * 1024 * 1024;

/**
 * The only operations this app may call: the three that READ a day's
 * collections — IP, Diagnostics, and OP consultation (ConsCollectionjs, added
 * to the service on 2026-10-06). The same HIS service has operations that
 * write — patient registration, appointments, payments — and an API Config is
 * free text, so this is checked here, at the one place every call goes
 * through, and not only on the screen that saves a config.
 */
const READ_METHODS = ['IpCollection', 'DiagCollectionjs', 'ConsCollectionjs'];

/**
 * Refuses a config that would call anything else. An ASMX service picks the
 * operation from the SOAPAction header, so that must name the same operation
 * as the request body — otherwise a config could say one and call another.
 */
function assertReadOnlyCall(config) {
  const method = String(config.soap_method || '');
  if (!READ_METHODS.includes(method)) {
    throw Object.assign(new Error(`"${method}" is not an HIS operation this app may call — only ${READ_METHODS.join(', ')}, which read collections`), { status: 422 });
  }
  const action = String(config.soap_action || '').trim();
  if (action && action.split('/').pop() !== method) {
    throw Object.assign(new Error(`SOAP Action "${action}" does not name the operation "${method}"`), { status: 422 });
  }
}

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

const xmlUnescape = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

/** Strips the key out of anything that may reach an error message, a run row or a log. */
function redact(textValue, secret) {
  let out = String(textValue ?? '');
  if (secret) out = out.split(secret).join('********');
  return out;
}

function buildEnvelope(method, namespace, params) {
  const body = Object.entries(params)
    .filter(([name]) => name)
    .map(([name, value]) => `<${name}>${xmlEscape(value ?? '')}</${name}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body><${method} xmlns="${xmlEscape(namespace)}">${body}</${method}></soap:Body></soap:Envelope>`
  );
}

function post(url, body, { soapAction, timeoutMs, tlsInsecure, contentType = 'text/xml; charset=utf-8' }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const payload = Buffer.from(body, 'utf8');
    const req = lib.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': payload.length,
          ...(soapAction ? { SOAPAction: soapAction } : {}),
        },
        rejectUnauthorized: !tlsInsecure,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error(`Response larger than ${MAX_BODY_BYTES / 1024 / 1024} MB`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`No answer within ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Pulls the JSON document out of the response body (see header comment). */
function extractJson(textBody, method) {
  const body = String(textBody || '').replace(/^﻿/, '').trim();

  const fault = body.match(/<(?:\w+:)?faultstring[^>]*>([\s\S]*?)<\/(?:\w+:)?faultstring>/i);
  if (fault) throw Object.assign(new Error(`API returned a SOAP fault: ${xmlUnescape(fault[1]).trim()}`), { status: 502 });

  if (body.startsWith('{') || body.startsWith('[')) {
    const xmlAt = body.search(/<\?xml|<(?:\w+:)?Envelope/i);
    const jsonText = (xmlAt === -1 ? body : body.slice(0, xmlAt)).trim();
    return JSON.parse(jsonText);
  }

  const resultRe = new RegExp(`<${method}Result[^>]*>([\\s\\S]*?)</${method}Result>`, 'i');
  const result = body.match(resultRe);
  if (result) return JSON.parse(xmlUnescape(result[1]).trim());

  throw Object.assign(new Error('API response holds no JSON data'), { status: 502 });
}

/** The row array: the configured root key, else a top-level array, else the first array property. */
function rowsOf(json, responseRoot) {
  if (responseRoot) {
    const rows = json?.[responseRoot];
    if (rows === undefined || rows === null) return [];
    if (!Array.isArray(rows)) throw Object.assign(new Error(`"${responseRoot}" in the API response is not a list`), { status: 502 });
    return rows;
  }
  if (Array.isArray(json)) return json;
  const firstArray = Object.values(json || {}).find(Array.isArray);
  return firstArray || [];
}

/**
 * @param config  api_configs row (snake_case) with the key already decrypted as `authKey`
 * @param params  { locValue, dateValue } in the API's own format
 * @param transport  (url, body, options) => Promise<{status, text}> — the real HTTP(S) post by default; tests pass a fake
 * @returns {{ rows: object[], total: number|null, rawBytes: number, rawText: string, durationMs: number }}
 */
async function callSoapApi(config, { locValue, dateValue }, transport = post) {
  assertReadOnlyCall(config);
  const authKey = config.authKey || '';
  const params = {
    [config.loc_param]: locValue,
    [config.date_param]: dateValue,
    ...(config.auth_param ? { [config.auth_param]: authKey } : {}),
  };
  const envelope = buildEnvelope(config.soap_method, config.soap_namespace, params);
  const started = Date.now();

  let response;
  try {
    response = await transport(config.url, envelope, {
      soapAction: config.soap_action,
      timeoutMs: config.timeout_ms || 60000,
      tlsInsecure: !!config.tls_insecure,
    });
  } catch (err) {
    const hint = /self[- ]signed|certificate/i.test(err.message) ? ' — tick "Allow self-signed certificate" in API Config if this server uses one' : '';
    throw Object.assign(new Error(redact(`Could not reach the API: ${err.message}${hint}`, authKey)), { status: 502 });
  }

  if (response.status >= 400) {
    // The HIS builds its answer with a serializer capped at about 2 MB. A busy
    // day's OP register is larger (Secunderabad, 03-Oct and 05-Oct 2026: about
    // 2,750 lines and up), and the service then fails instead of answering.
    // Nothing on this side can ask for less — the operation takes a unit and a
    // day, nothing else — so it is said plainly, for whoever must take it to the HIS team.
    if (/maxJsonLength/i.test(response.text)) {
      throw Object.assign(
        new Error(
          `HIS could not send this day: the answer is larger than the HIS server's own limit (maxJsonLength, about 2 MB) for "${config.soap_method}". ` +
            'The HIS team must raise that limit on their server — nothing was stored for this API.',
        ),
        { status: 502 },
      );
    }
    let detail = response.text.slice(0, 300);
    try {
      extractJson(response.text, config.soap_method);
    } catch (e) {
      if (/SOAP fault/.test(e.message)) detail = e.message;
    }
    throw Object.assign(new Error(redact(`API answered HTTP ${response.status}: ${detail}`, authKey)), { status: 502 });
  }

  let json;
  try {
    json = extractJson(response.text, config.soap_method);
  } catch (err) {
    const snippet = response.text.slice(0, 200).replace(/\s+/g, ' ');
    // HTTP 200 with nothing in it is how the HIS answers a key it does not
    // accept (2026-10-06: DiagCollectionjs called with the IpCollection key).
    const hint = /holds no JSON data/.test(err.message)
      ? ` — the HIS answers with nothing when it does not accept the API key: check the key saved for "${config.soap_method}" on API Config (each operation has its own)`
      : '';
    throw Object.assign(new Error(redact(`${err.message}${hint} (response starts: ${snippet})`, authKey)), { status: err.status || 502 });
  }

  const rows = rowsOf(json, config.response_root);
  const totalRaw = config.total_field ? json?.[config.total_field] : undefined;
  const total = totalRaw === undefined || totalRaw === null || totalRaw === '' ? null : Number(totalRaw);

  return {
    rows,
    total: Number.isFinite(total) ? total : null,
    rawBytes: Buffer.byteLength(response.text, 'utf8'),
    rawText: response.text,
    durationMs: Date.now() - started,
  };
}

module.exports = { callSoapApi, extractJson, rowsOf, buildEnvelope, redact, post, READ_METHODS, assertReadOnlyCall };
