const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('connect', () => {
    console.log('✅ Подключено к PostgreSQL');
});

pool.on('error', (err) => {
    console.error('❌ Ошибка PostgreSQL:', err);
});

async function query(sqlString, params = []) {
    const client = await pool.connect();
    try {
        const result = await client.query(sqlString, params);
        return result;
    } catch (err) {
        console.error('❌ Ошибка SQL:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

async function getOne(sqlString, params = []) {
    const result = await query(sqlString, params);
    return result.rows[0];
}

async function getMany(sqlString, params = []) {
    const result = await query(sqlString, params);
    return result.rows;
}

async function execute(sqlString, params = []) {
    const result = await query(sqlString, params);
    return { rowsAffected: result.rowCount };
}

async function insertAndGetId(sqlString, params = []) {
    const result = await query(sqlString, params);
    return result.rows[0].id;
}

async function getPool() {
    return pool;
}

module.exports = {
    getPool,
    query,
    getOne,
    getMany,
    execute,
    insertAndGetId,
    sql: null
};