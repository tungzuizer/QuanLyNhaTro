const { neon } = require('@neondatabase/serverless');

const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_dnlszBw4T2HV@ep-jolly-mode-atgnmc0h-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

const sql = neon(connectionString, { fullResults: true });

async function execQuery(queryText, params = []) {
  let cleanedSql = queryText;
  // Chuyển GROUP_CONCAT của SQLite sang STRING_AGG của Postgres
  cleanedSql = cleanedSql.replace(/\bGROUP_CONCAT\(([^,]+),\s*([^)]+)\)/gi, 'STRING_AGG($1, $2)');

  // Tách query theo các placeholder ? hoặc $1, $2
  const parts = cleanedSql.split(/\$\d+|\?/);
  parts.raw = parts;
  return await sql(parts, ...params);
}

// Khởi tạo các bảng & migrations cần thiết nếu chưa có
async function initDatabase() {
  try {
    await execQuery(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        room_code TEXT UNIQUE NOT NULL,
        zone TEXT NOT NULL,
        rent_price REAL DEFAULT 0,
        deposit REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'vacant',
        member_count INTEGER DEFAULT 0,
        billing_day INTEGER DEFAULT 30,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await execQuery(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        phone TEXT,
        cccd TEXT,
        start_date DATE NOT NULL,
        end_date DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await execQuery(`
      CREATE TABLE IF NOT EXISTS electricity_readings (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        old_reading REAL NOT NULL DEFAULT 0,
        new_reading REAL NOT NULL DEFAULT 0,
        consumption REAL NOT NULL DEFAULT 0,
        unit_price REAL NOT NULL,
        total_cost REAL NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, year, month)
      );
    `);

    await execQuery(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await execQuery(`
      CREATE TABLE IF NOT EXISTS rent_payments (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        rent_amount REAL NOT NULL DEFAULT 0,
        electricity_amount REAL NOT NULL DEFAULT 0,
        water_amount REAL NOT NULL DEFAULT 0,
        trash_amount REAL NOT NULL DEFAULT 0,
        residence_amount REAL NOT NULL DEFAULT 0,
        deposit_amount REAL NOT NULL DEFAULT 0,
        total_amount REAL NOT NULL DEFAULT 0,
        is_paid INTEGER NOT NULL DEFAULT 0,
        paid_at TIMESTAMP,
        note TEXT,
        tenant_name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(room_id, year, month)
      );
    `);

    // Migrations
    try {
      await execQuery(`ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS water_amount REAL NOT NULL DEFAULT 0`);
      await execQuery(`ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS trash_amount REAL NOT NULL DEFAULT 0`);
      await execQuery(`ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS residence_amount REAL NOT NULL DEFAULT 0`);
      await execQuery(`ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS deposit_amount REAL NOT NULL DEFAULT 0`);
    } catch (e) { }

    try {
      await execQuery(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS billing_day INTEGER DEFAULT 30`);
    } catch (e) { }

    try {
      await execQuery(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS handover_electricity REAL DEFAULT 0`);
    } catch (e) { }

    console.log('✅ [Database] Kết nối thành công tới PostgreSQL Cloud (Neon). Toàn bộ dữ liệu trực tiếp đã sẵn sàng!');
  } catch (err) {
    console.error('❌ Lỗi khởi tạo database Postgres:', err);
  }
}

const initPromise = initDatabase();

class DatabaseStatement {
  constructor(sqlQuery) {
    this.sql = sqlQuery;
  }

  parseRow(row) {
    if (!row) return null;
    for (const key in row) {
      if (typeof row[key] === 'string' && /^\d+$/.test(row[key])) {
        // Không convert nếu chuỗi bắt đầu bằng '0' và dài hơn 1 ký tự (như SĐT, CCCD, STK)
        if (row[key].startsWith('0') && row[key].length > 1) {
          continue;
        }
        const val = parseInt(row[key], 10);
        if (!isNaN(val)) row[key] = val;
      } else if (typeof row[key] === 'string' && /^\d+\.\d+$/.test(row[key])) {
        const val = parseFloat(row[key]);
        if (!isNaN(val)) row[key] = val;
      }
    }
    return row;
  }

  async get(...params) {
    await initPromise;
    const res = await execQuery(this.sql, params);
    return this.parseRow(res.rows[0]) || null;
  }

  async all(...params) {
    await initPromise;
    const res = await execQuery(this.sql, params);
    return res.rows.map(row => this.parseRow(row));
  }

  async run(...params) {
    await initPromise;
    const res = await execQuery(this.sql, params);
    return {
      changes: res.rowCount,
      lastInsertRowid: res.rows[0] ? (res.rows[0].id || null) : null
    };
  }
}

module.exports = {
  prepare: (sqlQuery) => new DatabaseStatement(sqlQuery)
};
