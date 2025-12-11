import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

let db: Database;

export async function initDB() {
    db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            tokens INTEGER DEFAULT 3,
            last_generation INTEGER DEFAULT 0,
            is_banned INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);

    // Set default cooldown if not exists (24 hours in ms)
    const cooldown = await db.get('SELECT value FROM config WHERE key = ?', 'cooldown_ms');
    if (!cooldown) {
        await db.run('INSERT INTO config (key, value) VALUES (?, ?)', 'cooldown_ms', (24 * 60 * 60 * 1000).toString());
    }
}

export async function getUser(userId: string) {
    let user = await db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) {
        await db.run('INSERT INTO users (id) VALUES (?)', userId);
        user = { id: userId, tokens: 3, last_generation: 0, is_banned: 0 };
    }
    return user;
}

export async function updateUser(userId: string, updates: Partial<{ tokens: number, last_generation: number, is_banned: number }>) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    await db.run(`UPDATE users SET ${fields} WHERE id = ?`, ...values, userId);
}

export async function getConfig(key: string): Promise<string | undefined> {
    const result = await db.get('SELECT value FROM config WHERE key = ?', key);
    return result?.value;
}

export async function setConfig(key: string, value: string) {
    await db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', key, value);
}
