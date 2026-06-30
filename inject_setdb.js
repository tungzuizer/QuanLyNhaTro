const fs = require('fs');
let content = fs.readFileSync('server.js', 'utf8');

// Find app.listen and inject setDb right after the console.log line
const listenIdx = content.indexOf("app.listen(PORT, async () => {");
const consoleLogStart = content.indexOf('console.log', listenIdx);
const consoleLogEnd = content.indexOf('\n', consoleLogStart) + 1;

const insertStr = '\n  // Inject db vao Tro ly LISO de web chat hoat dong khong can Telegram Bot\n  telegramBot.setDb(db);\n';

content = content.slice(0, consoleLogEnd) + insertStr + content.slice(consoleLogEnd);
fs.writeFileSync('server.js', content, 'utf8');
console.log('Done! Injected setDb at position', consoleLogEnd);
