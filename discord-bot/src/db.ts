import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { Pool } from 'pg';

// Interface for DB operations
interface DBAdapter {
    init(): Promise<void>;
    getUser(userId: string): Promise<any>;
    updateUser(userId: string, updates: any): Promise<void>;
    getConfig(key: string): Promise<string | undefined>;
    setConfig(key: string, value: string): Promise<void>;
}

let adapter: DBAdapter;

// --- SQLite Adapter ---
class SQLiteAdapter implements DBAdapter {
    private db!: Database;

    async init() {
        this.db = await open({
            filename: './database.sqlite',
            driver: sqlite3.Database
        });
        await this.db.exec(`
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
        await this.ensureCooldown();
    }

    async ensureCooldown() {
        const cooldown = await this.db.get('SELECT value FROM config WHERE key = ?', 'cooldown_ms');
        if (!cooldown) {
            await this.db.run('INSERT INTO config (key, value) VALUES (?, ?)', 'cooldown_ms', (24 * 60 * 60 * 1000).toString());
        }
    }

    async getUser(userId: string) {
        let user = await this.db.get('SELECT * FROM users WHERE id = ?', userId);
        if (!user) {
            await this.db.run('INSERT INTO users (id) VALUES (?)', userId);
            user = { id: userId, tokens: 3, last_generation: 0, is_banned: 0 };
        }
        return user;
    }

    async updateUser(userId: string, updates: any) {
        const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = Object.values(updates);
        await this.db.run(`UPDATE users SET ${fields} WHERE id = ?`, ...values, userId);
    }

    async getConfig(key: string) {
        const result = await this.db.get('SELECT value FROM config WHERE key = ?', key);
        return result?.value;
    }

    async setConfig(key: string, value: string) {
        await this.db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', key, value);
    }
}

// --- Postgres Adapter ---
class PostgresAdapter implements DBAdapter {
    private pool: Pool;

    constructor(connectionString: string) {
        this.pool = new Pool({ connectionString });
    }

    async init() {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                tokens INTEGER DEFAULT 3,
                last_generation BIGINT DEFAULT 0,
                is_banned INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        await this.ensureCooldown();
    }

    async ensureCooldown() {
        const res = await this.pool.query('SELECT value FROM config WHERE key = $1', ['cooldown_ms']);
        if (res.rows.length === 0) {
            await this.pool.query('INSERT INTO config (key, value) VALUES ($1, $2)', ['cooldown_ms', (24 * 60 * 60 * 1000).toString()]);
        }
    }

    async getUser(userId: string) {
        const res = await this.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        if (res.rows.length === 0) {
            await this.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
            return { id: userId, tokens: 3, last_generation: 0, is_banned: 0 };
        }
        // Convert string/bigint to number for compatibility if needed, or handle in app logic
        return { ...res.rows[0], last_generation: Number(res.rows[0].last_generation) };
    }

    async updateUser(userId: string, updates: any) {
        const keys = Object.keys(updates);
        const values = Object.values(updates);
        const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        await this.pool.query(`UPDATE users SET ${setClause} WHERE id = $1`, [userId, ...values]);
    }

    async getConfig(key: string) {
        const res = await this.pool.query('SELECT value FROM config WHERE key = $1', [key]);
        return res.rows[0]?.value;
    }

    async setConfig(key: string, value: string) {
        await this.pool.query(`
            INSERT INTO config (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = $2
        `, [key, value]);
    }
}

// --- Factory ---
export async function initDB() {
    if (process.env.DATABASE_URL) {
        console.log("Using PostgreSQL Database");
        adapter = new PostgresAdapter(process.env.DATABASE_URL);
    } else {
        console.log("Using SQLite Database");
        adapter = new SQLiteAdapter();
    }
    await adapter.init();
}

export async function getUser(userId: string) { return adapter.getUser(userId); }
export async function updateUser(userId: string, updates: any) { return adapter.updateUser(userId, updates); }
export async function getConfig(key: string) { return adapter.getConfig(key); }
export async function setConfig(key: string, value: string) { return adapter.setConfig(key, value); }
