const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
code = code.replace(/\\`/g, '`');
code = code.replace(/\\\${/g, '${');
fs.writeFileSync('server.js', code);
