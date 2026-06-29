const { Pool } = require('pg');
const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_dnlszBw4T2HV@ep-jolly-mode-atgnmc0h-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    const rooms = await client.query(`
      SELECT r.id, r.room_code, r.status, r.rent_price, r.deposit, r.member_count,
             (SELECT MIN(start_date) FROM tenants WHERE room_id = r.id) as lease_start_date,
             (SELECT STRING_AGG(full_name, ', ') FROM tenants WHERE room_id = r.id) as tenants
      FROM rooms r
      WHERE r.status = 'occupied'
      ORDER BY r.room_code
    `);
    console.log("Occupied Rooms:");
    console.table(rooms.rows);

    const payments = await client.query(`
      SELECT p.id, r.room_code, p.year, p.month, p.rent_amount, p.total_amount, p.is_paid, p.deposit_amount
      FROM rent_payments p
      JOIN rooms r ON p.room_id = r.id
      ORDER BY p.year DESC, p.month DESC, r.room_code
      LIMIT 20
    `);
    console.log("Recent Payments:");
    console.table(payments.rows);

  } catch(e) {
    console.error(e);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
