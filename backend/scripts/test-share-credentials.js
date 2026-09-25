/**
 * Pure-function checks for folder-watch/share-credentials.js — no DB, no
 * network, never actually runs `net use`.
 *   node scripts/test-share-credentials.js
 */
process.env.FOLDER_WATCH_KEY = 'test-key-one';
const { encryptSecret, decryptSecret, shareRoot, redact, connectShare } = require('../src/folder-watch/share-credentials');

const BS = String.fromCharCode(92);
const UNC = (...parts) => BS + BS + parts.join(BS);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

(async () => {
  // ---- encryption --------------------------------------------------------
  const secret = `p@ss"w&rd|${BS}x`;
  const enc = encryptSecret(secret);
  check('ciphertext does not contain the password', !enc.includes(secret));
  check('ciphertext has v1 format', /^v1:[^:]+:[^:]+:[^:]+$/.test(enc));
  check('round trip gives the password back', decryptSecret(enc) === secret);
  check('same password encrypts differently each time (random IV)', encryptSecret(secret) !== enc);

  const [v, iv, tag, data] = enc.split(':');
  const tampered = [v, iv, tag, Buffer.from('tampered').toString('base64')].join(':');
  let threw = false;
  try { decryptSecret(tampered); } catch { threw = true; }
  check('tampered ciphertext is rejected', threw);

  process.env.FOLDER_WATCH_KEY = 'a-different-key';
  threw = false;
  let msg = '';
  try { decryptSecret(enc); } catch (e) { threw = true; msg = e.message; }
  check('a changed key fails with a re-enter message', threw && /re-enter/.test(msg));
  process.env.FOLDER_WATCH_KEY = 'test-key-one';

  threw = false;
  try { decryptSecret('garbage'); } catch { threw = true; }
  check('unknown format is rejected', threw);

  // ---- share root --------------------------------------------------------
  check('root of \\\\srv\\share\\a\\b is \\\\srv\\share', shareRoot(UNC('srv', 'share', 'a', 'b')) === UNC('srv', 'share'));
  check('root of \\\\srv\\share is itself', shareRoot(UNC('srv', 'share')) === UNC('srv', 'share'));
  check('trailing backslash ignored', shareRoot(UNC('srv', 'share') + BS) === UNC('srv', 'share'));
  check('forward slashes accepted', shareRoot('//srv/share/x') === UNC('srv', 'share'));
  check('server only -> null', shareRoot(UNC('srv')) === null);
  check('local path -> null', shareRoot('D:' + BS + 'data') === null);

  // ---- redaction ---------------------------------------------------------
  check('password removed from error text', redact(`net use x ${secret} /user:a failed`, secret) === 'net use x ******** /user:a failed');
  check('no password -> text unchanged', redact('abc', '') === 'abc');

  // ---- connectShare no-ops (never reach net.exe) -------------------------
  const r1 = await connectShare({ folder_path: UNC('srv', 'share'), share_username: null });
  check('no user ID -> no connection attempt', r1.connected === false);
  const r2 = await connectShare({ folder_path: 'D:' + BS + 'data', share_username: 'u' });
  check('local path with user ID -> no connection attempt', r2.connected === false);

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})();
