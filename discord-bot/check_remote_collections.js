const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:svX%24Z%40xkn9zy%24sF@db.fhkfsdirfdritfguevfh.supabase.co:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    await client.connect();
    const res = await client.query("SELECT key, value FROM config WHERE key IN ('server_collection', 'partner_collections')");
    console.log("Remote Configured Collections:");
    res.rows.forEach(row => {
      console.log(`${row.key}: ${row.value}`);
    });
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

run();
