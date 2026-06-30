const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'server.js');
let content = fs.readFileSync(filePath, 'utf8');

// Regex hoặc chuỗi cần tìm để thay thế khối memberCount, waterAmount, trashAmount
const targetPattern = /\/\/ Tính toán số người dựa trên số tiền nước thực tế đã thanh toán[\s\S]+?let memberCount = room\.member_count \|\| 0;[\s\S]+?if \(payment && payment\.is_paid === 1 && payment\.water_amount > 0 && waterPrice > 0\) \{[\s\S]+?\}[\s\r\n]+const waterAmount = \(isExcludedMonth \|\| isDepositMonth\) && \(!payment \|\| payment\.is_paid !== 1\) \? 0 : \(payment && payment\.is_paid === 1 \? \(payment\.water_amount \|\| 0\) : waterPrice \* memberCount\);[\s\r\n]+const trashAmount = \(isExcludedMonth \|\| isDepositMonth\) && \(!payment \|\| payment\.is_paid !== 1\) \? 0 : \(payment && payment\.is_paid === 1 \? \(payment\.trash_amount \|\| 0\) : trashPrice \* memberCount\);/;

const replacement = `// Tính toán số người dựa trên số lượng thành viên hiện tại trong phòng
    const memberCount = room.member_count || 0;

    const waterAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : waterPrice * memberCount;
    const trashAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : trashPrice * memberCount;`;

if (targetPattern.test(content)) {
  content = content.replace(targetPattern, replacement);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✅ Đã cập nhật thành công logic: luôn tính nước/rác động theo số người hiện có của phòng!');
} else {
  console.error('❌ Lỗi: Không tìm thấy đoạn code mục tiêu trong server.js!');
}
