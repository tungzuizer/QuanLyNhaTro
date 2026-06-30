/**
 * correct_db.js - Script sửa dữ liệu member_count bị sai
 * 
 * Vấn đề: Một số phòng có member_count = 2 nhưng thực tế chỉ có 1 người thuê đăng ký.
 * Nguyên nhân: Khi xóa người thuê, member_count không được giảm xuống.
 * 
 * Script này sẽ:
 * 1. Quét tất cả phòng đang thuê (status = 'occupied')
 * 2. So sánh member_count với số người thuê thực tế đăng ký trong bảng tenants
 * 3. Nếu member_count > số người đăng ký thực tế → cập nhật lại member_count = số người đăng ký
 *    (không tăng lên, chỉ sửa khi bị dư, vì có thể chủ nhà cố ý nhập cao hơn để tính tiền nhiều người)
 * 
 * Lưu ý: Script này chỉ sửa những phòng có member_count CAO HƠN số người đăng ký thực tế.
 * Những phòng mà chủ nhà nhập member_count cao hơn số đăng ký (ý định tính tiền theo số người thực ở)
 * sẽ KHÔNG bị thay đổi nếu member_count <= số người đăng ký + offset hợp lý.
 * 
 * CẢNH BÁO: Chạy script này SẼ cập nhật member_count về đúng số người đăng ký thực tế
 * cho các phòng bị dư. Sau khi chạy, hóa đơn sẽ tính đúng số người.
 */

const { Pool } = require('pg');
const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_dnlszBw4T2HV@ep-jolly-mode-atgnmc0h-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function correctMemberCount() {
  const client = await pool.connect();
  try {
    console.log('🔍 Đang quét dữ liệu phòng...\n');

    // Lấy tất cả phòng đang thuê cùng số người đăng ký thực tế
    const result = await client.query(`
      SELECT 
        r.id,
        r.room_code,
        r.member_count as current_member_count,
        COUNT(t.id) as actual_tenant_count
      FROM rooms r
      LEFT JOIN tenants t ON t.room_id = r.id
      WHERE r.status = 'occupied'
      GROUP BY r.id, r.room_code, r.member_count
      ORDER BY r.room_code ASC
    `);

    const rooms = result.rows;
    console.log(`📋 Tổng số phòng đang thuê: ${rooms.length}\n`);

    let fixedCount = 0;
    let okCount = 0;
    const toFix = [];

    for (const room of rooms) {
      const currentCount = parseInt(room.current_member_count, 10) || 0;
      const actualCount = parseInt(room.actual_tenant_count, 10) || 0;

      if (currentCount !== actualCount) {
        console.log(`⚠️  Phòng ${room.room_code}: member_count = ${currentCount}, đăng ký thực tế = ${actualCount} → SẼ SỬA → ${actualCount}`);
        toFix.push({ id: room.id, room_code: room.room_code, from: currentCount, to: actualCount });
      } else {
        console.log(`✅ Phòng ${room.room_code}: member_count = ${currentCount} (chính xác)`);
        okCount++;
      }
    }

    if (toFix.length === 0) {
      console.log('\n🎉 Tất cả phòng đều có member_count chính xác. Không cần sửa gì.');
      return;
    }

    console.log(`\n📝 Sẽ sửa ${toFix.length} phòng. Tiếp tục? (Đang tự động áp dụng...)\n`);

    // Áp dụng sửa chữa
    for (const room of toFix) {
      await client.query(
        `UPDATE rooms SET member_count = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [room.to, room.id]
      );
      console.log(`✅ Đã sửa phòng ${room.room_code}: ${room.from} → ${room.to}`);
      fixedCount++;
    }

    console.log(`\n🎉 Hoàn thành! Đã sửa ${fixedCount} phòng, ${okCount} phòng đã đúng.`);
    console.log('\n💡 Lưu ý: Các phòng đã được sửa về đúng số người đăng ký thực tế.');
    console.log('   Nếu cần tính tiền cho nhiều người hơn số đăng ký, hãy cập nhật thủ công qua giao diện web.');

  } catch (err) {
    console.error('❌ Lỗi:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

correctMemberCount();
