const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  db.all("SELECT key, value FROM config WHERE key IN ('server_collection', 'partner_collections')", (err, rows) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log("Configured Collections:");
    rows.forEach(row => {
      console.log(`${row.key}: ${row.value}`);
    });
  });
});

db.close();
