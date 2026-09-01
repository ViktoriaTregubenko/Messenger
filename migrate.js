const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function runMigrations() {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'users'
            );
        `);
        const tableExists = res.rows[0].exists;

        if (!tableExists) {
            console.log('Таблицы не найдены, выполняем миграцию...');
            const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
            await client.query(sql);
            console.log('Миграция выполнена успешно');
        } else {
            console.log('Таблицы уже существуют, пропускаем миграцию');
        }
    } catch (err) {
        console.error('Ошибка миграции:', err.message);
    } finally {
        client.release();
    }
}

module.exports = runMigrations;