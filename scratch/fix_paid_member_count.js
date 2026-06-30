const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'server.js');
let content = fs.readFileSync(filePath, 'utf8');

const targetText = `    const waterPrice = parseFloat(settings['water_price']) || 20000;
    const trashPrice = parseFloat(settings['trash_price']) || 10000;
    const residencePrice = parseFloat(settings['residence_price']) || 50000;
    const memberCount = room.member_count || 0;`;

const replacement = `    const waterPrice = parseFloat(settings['water_price']) || 20000;
    const trashPrice = parseFloat(settings['trash_price']) || 10000;
    const residencePrice = parseFloat(settings['residence_price']) || 50000;
    
    // Tính toán số người dựa trên số tiền nước thực tế đã thanh toán để tránh lệch thông tin hiển thị trên hóa đơn cũ
    let memberCount = room.member_count || 0;
    if (payment && payment.is_paid === 1 && payment.water_amount > 0 && waterPrice > 0) {
      memberCount = Math.round(payment.water_amount / waterPrice);
    }`;

if (content.includes(targetText)) {
  content = content.replace(targetText, replacement);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✅ Đã cập nhật thành công logic tính toán memberCount cho hóa đơn đã thanh toán!');
} else {
  // Thử bản với regex đơn giản đề phòng CRLF
  const regex = /const\s+waterPrice\s*=\s*parseFloat\(settings\['water_price'\]\)\s*\|\|\s*20000;[\s\r\n]+const\s+trashPrice\s*=\s*parseFloat\(settings\['trash_price'\]\)\s*\|\|\s*10000;[\s\r\n]+const\s+residencePrice\s*=\s*parseFloat\(settings\['residence_price'\]\)\s*\|\|\s*50000;[\s\r\n]+const\s+memberCount\s*=\s*room\.member_count\s*\|\|\s*0;/;
  if (regex.test(content)) {
    content = content.replace(regex, replacement);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('✅ Đã cập nhật thành công qua regex!');
  } else {
    console.error('❌ Lỗi: Không tìm thấy khối khai báo memberCount trong server.js!');
  }
}
