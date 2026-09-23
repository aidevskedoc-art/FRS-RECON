/**
 * Seeds the 5 real users sriram gave (2026-09-21) into `users` /
 * `user_locations`. Idempotent — re-running updates name/role/branch instead
 * of erroring on the unique employee_id/username.
 *
 * Login username = employee ID (e.g. "AD4015"). Everyone starts on the same
 * temp password below with must_change_password = true, so nobody can use
 * the app without first setting their own password — sriram still needs to
 * hand these out to each person.
 *
 *   node scripts/seed-users.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const TEMP_PASSWORD = 'Yashoda@123';

// Branch mapping per sriram 2026-09-21 — explicitly said to be changeable
// later, not a firm commitment. Admin gets no location rows: role='Admin'
// bypasses location filtering entirely in application code.
const USERS = [
  { employeeId: 'AD4015', fullName: 'Mrs. Radhika K',       role: 'Admin',   locations: [] },
  { employeeId: 'AD7122', fullName: 'Mrs. Anusha T',         role: 'Auditor', locations: ['Somajiguda'] },
  { employeeId: 'AD7141', fullName: 'Mr. Ramanjaneyulu',     role: 'Auditor', locations: ['Secunderabad'] },
  { employeeId: 'AD7278', fullName: 'Mr. Ravi K',            role: 'Auditor', locations: ['Hitech City'] },
  { employeeId: 'AD7324', fullName: 'Mr. Siva Gangadhar',    role: 'Auditor', locations: ['Malakpet'] },
];

async function seedUsers() {
  const passwordHash = await bcrypt.hash(TEMP_PASSWORD, 10);

  for (const u of USERS) {
    const { rows } = await db.query(
      `INSERT INTO users (employee_id, username, password_hash, full_name, role)
       VALUES ($1, $1, $2, $3, $4)
       ON CONFLICT (LOWER(employee_id)) DO UPDATE
         SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, updated_at = now()
       RETURNING id, employee_id, full_name, role`,
      [u.employeeId, passwordHash, u.fullName, u.role]
    );
    const userId = rows[0].id;
    console.log(`  ${rows[0].employee_id}  ${rows[0].full_name}  (${rows[0].role})  id=${userId}`);

    await db.query(`DELETE FROM user_locations WHERE user_id = $1`, [userId]);
    for (const locName of u.locations) {
      const { rows: locRows } = await db.query(`SELECT id FROM locations WHERE name = $1`, [locName]);
      if (locRows.length === 0) {
        console.warn(`    ! location "${locName}" not found, skipped`);
        continue;
      }
      await db.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, locRows[0].id]
      );
      console.log(`    -> ${locName}`);
    }
  }

  console.log(`\nDone. Temp password for all 5: ${TEMP_PASSWORD} (must_change_password = true for each).`);
}

seedUsers()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
