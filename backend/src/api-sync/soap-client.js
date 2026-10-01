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

function post(url, body, { soapAction, timeoutMs, tlsInsecure }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const payload = Buffer.from(body, 'utf8');
    const req = lib.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
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
    throw Object.assign(new Error(redact(`${err.message} (response starts: ${snippet})`, authKey)), { status: err.status || 502 });
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

module.exports = { callSoapApi, extractJson, rowsOf, buildEnvelope, redact };
