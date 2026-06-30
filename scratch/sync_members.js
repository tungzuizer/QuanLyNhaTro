const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_dnlszBw4T2HV@ep-jolly-mode-atgnmc0h-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Đang kiểm tra và đồng bộ số lượng thành viên trong phòng...');
    
    // Lấy tất cả các phòng và số lượng người thuê đang hoạt động
    const res = await client.query(`
      SELECT 
        r.id, 
        r.room_code, 
        r.zone, 
        r.member_count as db_count, 
        COUNT(t.id) as actual_count
      FROM rooms r
      LEFT JOIN tenants t ON t.room_id = r.id AND (t.end_date IS NULL)
      GROUP BY r.id, r.room_code, r.zone, r.member_count
      ORDER BY r.zone, r.room_code
    `);
    
    const rooms = res.rows;
    console.log(`Tìm thấy tổng cộng ${rooms.length} phòng.`);
    
    let updatedCount = 0;
    for (const room of rooms) {
      const dbCount = parseInt(room.db_count) || 0;
      const actualCount = parseInt(room.actual_count) || 0;
      
      if (dbCount !== actualCount) {
        console.log(`Phòng ${room.room_code} (Khu ${room.zone}): DB đang hiển thị ${dbCount} người, thực tế có ${actualCount} người. Tiến hành đồng bộ...`);
        await client.query('UPDATE rooms SET member_count = $1 WHERE id = $2', [actualCount, room.id]);
        updatedCount++;
      }
    }
    
    console.log(`Đồng bộ hoàn tất! Đã cập nhật ${updatedCount} phòng.`);
  } catch (err) {
    console.error('Lỗi khi đồng bộ:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
