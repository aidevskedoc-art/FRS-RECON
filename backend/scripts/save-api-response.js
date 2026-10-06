/**
 * Saves one unit-day's raw HIS API response to a file, so a mapping can be
 * worked out (and checked) against everything the API really sends — the Test
 * button on API Config shows only the first few rows. Read-only: it calls the
 * API and writes files; nothing is stored in the database.
 *
 *   npm run save-api-response -- IpCollection 1 2026-09-15
 *   npm run save-api-response -- DiagCollectionjs 9 2026-09-30 D:\some\folder
 *
 * Arguments: SOAP method, HIS loc code, date (YYYY-MM-DD), output folder
 * (default: "mis-api-samples" beside the repository — the response holds
 * patient names, so it must not land inside the repository).
 *
 * The connection and key come from the saved API Config (Master Data → API
 * Config). A method with no config of its own borrows the connection of a
 * saved config for the same service — so DiagCollectionjs works as soon as
 * IpCollection is set up. HIS_API_KEY in backend/.env is used only when no
 * key is saved yet. The key is never printed or written.
 *
 * The service is called the way the application calls it (SOAP). When that
 * answer holds no data it is saved anyway, and the same operation is asked
 * again in the two other ways the service offers — a plain HTTP POST, then a
 * plain GET — so one run shows which way this operation answers. The two
 * operations differ: IpCollection answers SOAP and not a plain GET, while the
 * only DiagCollectionjs answer with data so far came from a plain GET (loc 9,
 * 30/09/2026; SOAP and a plain POST for loc 1 gave HTTP 200 with nothing in
 * it, whatever format the date was sent in).
 *
 * The saved file is exactly what the service sent, so it can be given to
 * `node scripts/test-api-sync.js <file>` as well. Only sizes, counts and XML
 * element names are printed, never the answer's text.
 */
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');
const db = require('../src/db');
const { decryptSecret } = require('../src/folder-watch/share-credentials');
const { callSoapApi, extractJson, rowsOf, redact, post } = require('../src/api-sync/soap-client');
const { formatRequestDate } = require('../src/api-sync/apply-mapping');

/**
 * The only methods this script will call, and the JSON key each one's rows sit
 * under (null = not known yet: the answer's first list is taken).
 */
const METHODS = {
  IpCollection: 'IPcollectionv',
  DiagCollectionjs: 'Diagcollectionv',
  ConsCollectionjs: null,
};

/** The ways one operation can be asked, in the order they are tried. */
const STYLES = [
  { id: 'soap', label: 'SOAP' },
  { id: 'post', label: 'plain HTTP POST' },
  { id: 'get', label: 'plain GET' },
];

const [method, locCode, date, outDirArg] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  console.error(`Usage: npm run save-api-response -- <${Object.keys(METHODS).join('|')}> <HIS loc code> <YYYY-MM-DD> [output folder]`);
  process.exit(1);
}

/** The saved config for this method, or another saved config of the same service re-pointed at it. */
async function configFor(soapMethod) {
  const { rows } = await db.query('SELECT * FROM api_configs ORDER BY (soap_method = $1) DESC, (auth_key_enc IS NOT NULL) DESC, id', [soapMethod]);
  const own = rows.find((c) => c.soap_method === soapMethod);
  if (own) return own;
  const sibling = rows.find((c) => Object.prototype.hasOwnProperty.call(METHODS, c.soap_method));
  if (!sibling) throw new Error('No HIS API is set up yet — add one on Master Data → API Config first.');
  const swap = (text) => (text ? String(text).split(sibling.soap_method).join(soapMethod) : text);
  // The sibling's address and settings, never its key: each operation has its
  // own (2026-10-06), so this one's comes from HIS_API_KEY until it is saved.
  return {
    ...sibling, auth_key_enc: null, soap_method: soapMethod, url: swap(sibling.url), soap_action: swap(sibling.soap_action), response_root: METHODS[soapMethod],
  };
}

/** What an answer is made of — sizes and XML element names only, never its text. */
function shapeOf(answer) {
  const text = answer.text;
  const xmlAt = text.search(/<\?xml|<(?:\w+:)?Envelope/i);
  if (xmlAt === -1) return `HTTP ${answer.status}, ${text.trim().length} characters, no XML in it`;
  const close = text.match(/<\/(?:\w+:)?Envelope>/i);
  const xmlEnd = close ? close.index + close[0].length : text.length;
  const names = [...new Set([...text.slice(xmlAt, xmlEnd).matchAll(/<([A-Za-z_][\w:.-]*)/g)].map((m) => m[1]))].slice(0, 12);
  return (
    `HTTP ${answer.status}, ${text.slice(0, xmlAt).trim().length} characters before the XML, ` +
    `${xmlEnd - xmlAt} of XML (${names.join(' > ')}), ${text.slice(xmlEnd).trim().length} after it`
  );
}

/** Why an answer could not be used, without quoting it — a JSON parse error's own message quotes the text. */
function whyNot(err, authKey) {
  const message = redact(err.message, authKey).replace(/ \(response starts:[\s\S]*$/, '');
  const fault = message.match(/SOAP fault: [\s\S]*/);
  if (fault) return `the service reported a ${fault[0]}`;
  const http = message.match(/HTTP \d+/);
  if (http) return `the service answered ${http[0]}`;
  return /no JSON data/.test(message) ? 'it holds no JSON' : 'its JSON could not be read';
}

/** …/Service.asmx/<operation> — where the service takes an operation as a plain HTTP request. */
function operationUrl(config) {
  const target = new URL(config.url);
  target.search = '';
  target.pathname = `${target.pathname.replace(/\/$/, '')}/${config.soap_method}`;
  return target;
}

function inputsOf(config, authKey, { locValue, dateValue }) {
  const fields = new URLSearchParams({ [config.loc_param]: String(locValue), [config.date_param]: dateValue });
  if (config.auth_param) fields.set(config.auth_param, authKey);
  return fields;
}

/** The operation as a plain HTTP POST: inputs as form fields, so the key stays out of the address. */
function postForm(config, authKey, params) {
  return post(operationUrl(config).toString(), inputsOf(config, authKey, params).toString(), {
    contentType: 'application/x-www-form-urlencoded',
    timeoutMs: config.timeout_ms || 60000,
    tlsInsecure: !!config.tls_insecure,
  });
}

/**
 * The operation as a plain GET. Unlike the two POST forms the key travels in
 * the address, so this is tried last, and a failure is reported by its error
 * code alone — never by a message that could carry the address.
 */
async function getPlain(config, authKey, params) {
  const target = operationUrl(config);
  target.search = inputsOf(config, authKey, params).toString();
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(config.timeout_ms || 60000) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    throw new Error(err.cause?.code || err.name || 'request failed');
  }
}

function rowsIn(answer, config) {
  if (answer.status >= 400) throw new Error(`HTTP ${answer.status}`);
  const json = extractJson(answer.text, config.soap_method);
  const total = config.total_field ? json?.[config.total_field] : undefined;
  return { rows: rowsOf(json, config.response_root), total: total ?? 'n/a' };
}

async function main() {
  if (!Object.prototype.hasOwnProperty.call(METHODS, method || '')) fail(`Unknown method "${method}".`);
  if (!/^\d+$/.test(locCode || '')) fail('The HIS loc code must be a number (e.g. 1, 5, 3, 9).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail('The date must be YYYY-MM-DD.');

  const config = await configFor(method);
  const authKey = config.auth_key_enc ? decryptSecret(config.auth_key_enc) : process.env.HIS_API_KEY || '';
  if (config.auth_param && !authKey) throw new Error('No API key is saved on API Config, and HIS_API_KEY is not set in backend/.env.');

  const { rows: units } = await db.query('SELECT name FROM locations WHERE his_loc_code = $1', [Number(locCode)]);
  const unit = units[0] ? units[0].name : `loc ${locCode}`;
  const params = { locValue: Number(locCode), dateValue: formatRequestDate(date, config.date_format) };

  const outDir = path.resolve(outDirArg || path.join(__dirname, '..', '..', '..', 'mis-api-samples'));
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${method}-loc${locCode}-${date}`);
  const save = (file, text) => {
    fs.writeFileSync(file, text, 'utf8');
    console.log(`Saved to ${file}`);
  };
  const heading = `${method} · ${unit} · ${date}`;

  /**
   * One call. The answer is kept as it arrives, so one that cannot be read can
   * still be saved — that is when the file is needed most. Only a service that
   * cannot be reached at all throws.
   */
  async function ask(style) {
    const started = Date.now();
    let answer = null;
    try {
      if (style === 'soap') {
        const call = await callSoapApi({ ...config, authKey }, params, async (...args) => (answer = await post(...args)));
        return { answer, rows: call.rows, total: call.total ?? 'n/a', ms: call.durationMs };
      }
      answer = await (style === 'get' ? getPlain : postForm)(config, authKey, params);
      return { answer, ...rowsIn(answer, config), ms: Date.now() - started };
    } catch (err) {
      const message = redact(err.message, authKey);
      if (!answer) throw new Error(/^Could not reach/.test(message) ? message : `Could not reach the API: ${message}`);
      return { answer, why: whyNot(err, authKey) };
    }
  }

  for (const style of STYLES) {
    const tried = await ask(style.id);
    if (tried.rows) {
      const how = style.id === 'soap' ? '' : `, as a ${style.label}`;
      console.log(`${heading}${how}: ${tried.rows.length} rows received, Total = ${tried.total}, ${tried.ms} ms`);
      save(`${base}.txt`, tried.answer.text);
      return;
    }
    console.log(`${heading}: the ${style.label} answer cannot be used, ${tried.why}.`);
    console.log(`  ${shapeOf(tried.answer)}`);
    save(`${base}-${style.id}-answer.txt`, tried.answer.text);
  }
  console.log('No way of asking gave data for this unit and day.');
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
