/**
 * User ID + password for the client's shared folder (the client gave a share
 * that needs its own login, not the backend machine's Windows account).
 *
 * The password is stored AES-256-GCM encrypted in folder_watch_config and is
 * never sent back to the browser. Before each scan the backend opens the
 * share with `net use \\server\share <password> /user:<id>` — no drive
 * letter, not persistent — and then reads the UNC path exactly as before.
 *
 * Key: FOLDER_WATCH_KEY from .env if set, else JWT_SECRET. Changing whichever
 * one is in use makes the saved password unreadable — re-enter it on the
 * Shared Folder Automation screen.
 */
const crypto = require('crypto');
const { execFile } = require('child_process');

const ALGO = 'aes-256-gcm';
const BACKSLASH = String.fromCharCode(92);

function encryptionKey() {
  const secret = process.env.FOLDER_WATCH_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('Set FOLDER_WATCH_KEY (or JWT_SECRET) in backend/.env before saving a share password.');
  return crypto.scryptSync(secret, 'cbdr-folder-watch', 32);
}

/** 'v1:<iv>:<tag>:<ciphertext>', all base64. */
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Saved share password is in an unknown format — re-enter it.');
  try {
    const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Saved share password could not be decrypted (the encryption key changed?) — re-enter it.');
  }
}

/** '\\server\share\sub\folder' -> '\\server\share' — net use connects to the share, not a subfolder. */
function shareRoot(folderPath) {
  const p = String(folderPath).trim().replace(/\//g, BACKSLASH);
  if (!p.startsWith(BACKSLASH + BACKSLASH)) return null; // local path / mapped drive — no login needed
  const parts = p.slice(2).split(BACKSLASH).filter(Boolean);
  if (parts.length < 2) return null;
  return BACKSLASH + BACKSLASH + parts[0] + BACKSLASH + parts[1];
}

/** Strips the password out of anything that might end up in a run's error_message or a log. */
function redact(text, password) {
  let out = String(text || '');
  if (password) out = out.split(password).join('********');
  return out;
}

function runNetUse(args, password) {
  return new Promise((resolve, reject) => {
    // execFile, not exec: arguments go straight to net.exe, no shell, so a
    // password with quotes/&/| can't break out into a command.
    execFile('net', ['use', ...args], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const detail = redact(`${stderr || ''} ${stdout || ''}`.replace(/\s+/g, ' ').trim(), password);
      const e = new Error(detail || 'net use failed');
      e.systemError = (detail.match(/System error (\d+)/i) || [])[1] || null;
      reject(e);
    });
  });
}

const FRIENDLY = {
  5: 'access denied — the user ID has no permission on this share',
  53: 'network path not found — check the server name, or that this server can reach it',
  67: 'share name not found — check the share part of the path',
  86: 'wrong password',
  1326: 'user ID or password is incorrect',
  1909: 'the account is locked out',
  1219: 'this server is already connected to the share with a different user',
};

/**
 * Opens the configured share with the saved login, if one is saved. Does
 * nothing when no user ID is configured (the backend's own Windows account is
 * used, which is how \\YHCORP-ED7080\BS_share_san worked).
 */
async function connectShare(config) {
  const user = config?.share_username;
  if (!user) return { connected: false, reason: 'no login configured' };
  const root = shareRoot(config.folder_path);
  if (!root) return { connected: false, reason: 'not a \\\\server\\share path' };
  if (process.platform !== 'win32') {
    throw new Error('A share user ID/password is only supported when the backend runs on Windows.');
  }
  const password = config.share_password_enc ? decryptSecret(config.share_password_enc) : '';
  const args = [root, password, `/user:${user}`, '/persistent:no'];

  try {
    await runNetUse(args, password);
  } catch (err) {
    if (err.systemError !== '1219') throw wrap(err, root, user);
    // Already connected as someone else (or a stale session): drop that
    // connection to this one share and connect again with the saved login.
    await runNetUse([root, '/delete', '/y'], password).catch(() => {});
    try {
      await runNetUse(args, password);
    } catch (err2) {
      throw wrap(err2, root, user);
    }
  }
  return { connected: true, root };
}

function wrap(err, root, user) {
  const friendly = FRIENDLY[err.systemError];
  return new Error(`Could not connect to ${root} as ${user}${friendly ? ` (${friendly})` : ''}: ${err.message}`);
}

module.exports = { encryptSecret, decryptSecret, shareRoot, redact, connectShare };
