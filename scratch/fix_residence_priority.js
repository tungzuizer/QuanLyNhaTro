const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'server.js');
let content = fs.readFileSync(filePath, 'utf8');

const startText = 'const includeResidenceParam = req.query.include_residence;';
const endText = 'const depositAmount = isExcludedMonth';

const startIndex = content.indexOf(startText);
const endIndex = content.indexOf(endText);

if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
  const replacement = `const includeResidenceParam = req.query.include_residence; // 'force' | 'none' | 'auto' | undefined
    let residenceAmount;
    if (includeResidenceParam === 'none') {
      residenceAmount = 0;
    } else if (includeResidenceParam === 'force') {
      residenceAmount = residencePrice * memberCount;
    } else if (payment && payment.is_paid === 1 && payment.residence_amount !== null && payment.residence_amount !== undefined) {
      // Đã thu tiền rồi: dùng giá trị thực tế
      residenceAmount = payment.residence_amount;
    } else if ((isExcludedMonth || isDepositMonth) && (!payment || payment.is_paid !== 1)) {
      residenceAmount = 0;
    } else {
      // Tự động: chỉ tính tháng đầu tiên
      residenceAmount = isFirstMonth ? residencePrice * memberCount : 0;
    }
    `;
  
  content = content.substring(0, startIndex) + replacement + content.substring(endIndex);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✅ Đã cập nhật thành công logic tạm trú bằng index-based patch!');
} else {
  console.error('❌ Lỗi: Không tìm thấy vị trí startText hoặc endText trong server.js!');
}
