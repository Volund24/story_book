
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

(async () => {
    const db = await open({
        filename: './discord-bot/database.sqlite',
        driver: sqlite3.Database
    });

    const config = await db.all('SELECT * FROM config');
    console.log('Current Config:', config);
})();
