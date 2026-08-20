const sql = require('mssql');

const config = {
    server: 'KIANA\\SQLEXPRESS01',
    port: 1434,
    database: 'Messenger_Victoria',
    user: 'MessengerApp',
    password: 'StrongPassword123!',
    options: {
        trustServerCertificate: true,
        encrypt: true,
        enableArithAbort: true,
        connectionTimeout: 30000,
        requestTimeout: 30000
    }
};

let pool = null;

async function getPool() {
    try {
        if (!pool) {
            pool = await sql.connect(config);
        }
        return pool;
    } catch (err) {
        console.error(' Ошибка подключения к базе данных:', err.message);
        throw err;
    }
}

async function query(sqlString, params = {}) {
    const pool = await getPool();
    const request = pool.request();
    Object.keys(params).forEach(key => {
        request.input(key, params[key]);
    });
    return await request.query(sqlString);
}

async function getOne(sqlString, params = {}) {
    const result = await query(sqlString, params);
    return result.recordset[0];
}

async function getMany(sqlString, params = {}) {
    const result = await query(sqlString, params);
    return result.recordset;
}

async function execute(sqlString, params = {}) {
    const result = await query(sqlString, params);
    return { rowsAffected: result.rowsAffected ? result.rowsAffected[0] : 0 };
}

async function insertAndGetId(sqlString, params = {}) {
    const result = await query(sqlString + '; SELECT SCOPE_IDENTITY() AS id;', params);
    return result.recordset[0].id;
}

async function testConnection() {
    try {
        const pool = await getPool();
        await pool.request().query('SELECT 1');
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = {
    getPool,
    query,
    getOne,
    getMany,
    execute,
    insertAndGetId,
    testConnection,
    sql
};