const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'server.js');
let content = fs.readFileSync(filePath, 'utf8');

// Sử dụng regex linh hoạt bỏ qua loại dấu xuống dòng (\r\n vs \n)
const regex = /const\s+waterAmount\s*=\s*\(isExcludedMonth\s*\|\|\s*isDepositMonth\)[^;]+payment\.water_amount[^;]+;[\s\r\n]+const\s+trashAmount\s*=\s*\(isExcludedMonth\s*\|\|\s*isDepositMonth\)[^;]+payment\.trash_amount[^;]+;[\s\r\n\S]+?const\s+depositAmount\s*=[^;]+?\((payment\.deposit_amount\s*\|\|\s*0)\)[^;]+?;/g;

// Chúng ta tìm đoạn cụ thể và thay thế bằng chuỗi thay thế mong muốn
const pattern = /const\s+waterAmount\s*=\s*\(isExcludedMonth\s*\|\|\s*isDepositMonth\)\s*&&\s*\(!payment\s*\|\|\s*payment\.is_paid\s*!==\s*1\)\s*\?\s*0\s*:\s*\(payment\s*\?\s*\(payment\.water_amount\s*\|\|\s*0\)\s*:\s*waterPrice\s*\*\s*memberCount\);/;
if (pattern.test(content)) {
  console.log('Tìm thấy waterAmount, tiến hành thay thế...');
  content = content.replace(
    /const\s+waterAmount\s*=\s*\(isExcludedMonth\s*\|\|\s*isDepositMonth\)\s*&&\s*\(!payment\s*\|\|\s*payment\.is_paid\s*!==\s*1\)\s*\?\s*0\s*:\s*\(payment\s*\?\s*\(payment\.water_amount\s*\|\|\s*0\)\s*:\s*waterPrice\s*\*\s*memberCount\);/g,
    'const waterAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (payment && payment.is_paid === 1 ? (payment.water_amount || 0) : waterPrice * memberCount);'
  );
  content = content.replace(
    /const\s+trashAmount\s*=\s*\(isExcludedMonth\s*\|\|\s*isDepositMonth\)\s*&&\s*\(!payment\s*\|\|\s*payment\.is_paid\s*!==\s*1\)\s*\?\s*0\s*:\s*\(payment\s*\?\s*\(payment\.trash_amount\s*\|\|\s*0\)\s*:\s*trashPrice\s*\*\s*memberCount\);/g,
    'const trashAmount = (isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1) ? 0 : (payment && payment.is_paid === 1 ? (payment.trash_amount || 0) : trashPrice * memberCount);'
  );
  content = content.replace(
    /\} else if \(payment && payment\.residence_amount !== null && payment\.residence_amount !== undefined\) \{/g,
    '} else if (payment && payment.is_paid === 1 && payment.residence_amount !== null && payment.residence_amount !== undefined) {'
  );
  content = content.replace(
    /const\s+depositAmount\s*=\s*isExcludedMonth\s*&&\s*\(!payment\s*\|\|\s*payment\.is_paid\s*!==\s*1\)\s*\?\s*0\s*:\s*\(payment\s*\?\s*\(payment\.deposit_amount\s*\|\|\s*0\)\s*:\s*\(isDepositMonth\s*\?\s*\(room\.deposit\s*\|\|\s*0\)\s*:\s*0\)\);/g,
    'const depositAmount = isExcludedMonth && (!payment || payment.is_paid !== 1) ? 0 : (payment && payment.is_paid === 1 ? (payment.deposit_amount || 0) : (isDepositMonth ? (room.deposit || 0) : 0));'
  );
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✅ Đã cập nhật thành công qua regex!');
} else {
  console.log('❌ Vẫn không match regex!');
}
