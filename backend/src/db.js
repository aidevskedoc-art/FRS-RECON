const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Return DATE columns as the plain 'YYYY-MM-DD' string pg gives us, instead
// of letting node-postgres build a JS Date at *local* midnight. Converting
// such a Date to ISO shifts it backwards in any positive-offset timezone
// (in IST, 2026-09-15 00:00+05:30 becomes 2026-09-14T18:30Z), which showed
// up as every extracted policy date landing one day early. Policy dates are
// calendar dates with no time component, so a string is the honest
// representation. OID 1082 = DATE.
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX) || 10,
});

function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Creates the target database (PGDATABASE) if it doesn't exist yet.
 * Connects to a separate maintenance database (default "postgres" — the
 * near-universal Postgres convention, overridable via PGMAINTENANCE_DB for
 * managed services that restrict it) since a connection can't CREATE
 * DATABASE while pointed at a database that doesn't exist. Uses its own
 * short-lived Pool, closed before returning — the app's main `pool` above
 * stays configured for PGDATABASE throughout.
 */
async function ensureDatabase() {
  const targetDb = process.env.PGDATABASE;
  if (!targetDb) throw new Error('PGDATABASE is not set');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(targetDb)) {
    throw new Error(`PGDATABASE "${targetDb}" is not a safe identifier (letters/digits/underscore only)`);
  }

  const maintenancePool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGMAINTENANCE_DB || 'postgres',
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 1,
  });

  try {
    const { rows } = await maintenancePool.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
    if (rows.length === 0) {
      await maintenancePool.query(`CREATE DATABASE "${targetDb}"`);
      console.log(`Database "${targetDb}" did not exist — created it.`);
    }
  } finally {
    await maintenancePool.end();
  }
}

async function ensureSchema() {
  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schemaSql);
}

module.exports = { pool, query, withTransaction, ensureDatabase, ensureSchema };
