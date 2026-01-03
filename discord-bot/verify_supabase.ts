import { Pool } from 'pg';

const connectionString = 'postgresql://postgres:svX%24Z%40xkn9zy%24sF@db.fhkfsdirfdritfguevfh.supabase.co:6543/postgres';

const pool = new Pool({
    connectionString,
});

async function verify() {
    try {
        console.log("Connecting to Supabase...");
        const client = await pool.connect();
        console.log("Connected!");

        console.log("\n--- Checking 'users' table columns ---");
        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users';
        `);
        
        if (res.rows.length === 0) {
            console.log("Table 'users' does not exist!");
        } else {
            console.table(res.rows);
        }

        console.log("\n--- Checking 'config' table columns ---");
        const resConfig = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'config';
        `);
        
        if (resConfig.rows.length === 0) {
            console.log("Table 'config' does not exist!");
        } else {
            console.table(resConfig.rows);
        }

        client.release();
    } catch (err) {
        console.error("Error connecting or querying:", err);
    } finally {
        await pool.end();
    }
}

verify();
