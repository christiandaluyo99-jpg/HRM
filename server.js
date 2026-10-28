require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE = 'aster_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DEFAULT_ROOM_TYPES = [
  { name: 'Garden Twin', rooms: ['101', '102', '103'], rate: 225, capacity: 3 },
  { name: 'Deluxe Queen', rooms: ['201', '202', '203', '204'], rate: 185, capacity: 2 },
  { name: 'King Suite', rooms: ['301', '302', '303'], rate: 285, capacity: 2 },
  { name: 'The Aster Penthouse', rooms: ['401', '402'], rate: 460, capacity: 4 }
];
const VALID_STATUSES = new Set(['Reserved', 'Checked in', 'Checked out', 'Cancelled']);

function propertyDateKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters.');
}
if (!process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
  throw new Error('MYSQL_USER and MYSQL_DATABASE must be set in the environment.');
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  ...(process.env.MYSQL_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {})
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publicAdmin(admin) {
  return { email: admin.email, name: admin.name, position: admin.position };
}

function createSession(email) {
  const payload = Buffer.from(JSON.stringify({
    email,
    expiresAt: Date.now() + SESSION_DURATION_MS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof session.email !== 'string' || session.expiresAt <= Date.now()) return null;
    return session.email;
  } catch {
    return null;
  }
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge
  };
}

function sessionCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === SESSION_COOKIE) {
      return part.slice(separator + 1).trim();
    }
  }
  return '';
}

async function findAdmin(email) {
  const [rows] = await pool.execute(
    'SELECT email, name, position, password_hash FROM admin_accounts WHERE email = ?',
    [email]
  );
  return rows[0] || null;
}

async function requireAdmin(req, res, next) {
  try {
    const email = verifySession(sessionCookie(req));
    if (!email) throw httpError(401, 'Please sign in to continue.');
    const admin = await findAdmin(email);
    if (!admin) throw httpError(401, 'Please sign in to continue.');
    req.admin = admin;
    next();
  } catch (error) {
    next(error);
  }
}

function validateRoomTypes(roomTypes) {
  if (!Array.isArray(roomTypes) || !roomTypes.length || roomTypes.length > 100) {
    throw httpError(400, 'Room inventory must contain between 1 and 100 room types.');
  }
  const typeNames = new Set();
  const roomNumbers = new Set();
  for (const type of roomTypes) {
    if (!type || typeof type.name !== 'string' || !type.name.trim() || type.name.trim().length > 100 ||
        !Array.isArray(type.rooms) || !Number.isFinite(type.rate) || type.rate <= 0 ||
        !Number.isInteger(type.capacity) || type.capacity < 1 || type.capacity > 20) {
      throw httpError(400, 'The room inventory contains an invalid room type.');
    }
    const typeName = type.name.trim();
    if (typeNames.has(typeName)) throw httpError(400, 'Room type names must be unique.');
    typeNames.add(typeName);
    for (const room of type.rooms) {
      const number = String(room).trim().toUpperCase();
      if (!/^[A-Z0-9-]{1,8}$/.test(number) || roomNumbers.has(number)) {
        throw httpError(400, 'Room numbers must be valid and unique.');
      }
      roomNumbers.add(number);
    }
  }
  if (!roomNumbers.size) throw httpError(400, 'At least one room is required.');
}

function validateReservations(reservations) {
  if (!Array.isArray(reservations) || reservations.length > 10000) {
    throw httpError(400, 'Reservations must be a list with no more than 10,000 records.');
  }
  const ids = new Set();
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  for (const reservation of reservations) {
    if (!reservation || typeof reservation.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(reservation.id) ||
        ids.has(reservation.id) || typeof reservation.guest !== 'string' || !reservation.guest.trim() ||
        reservation.guest.length > 80 || typeof reservation.email !== 'string' ||
        reservation.email.length > 254 || typeof reservation.phone !== 'string' || reservation.phone.length > 32 ||
        typeof reservation.roomType !== 'string' || reservation.roomType.length > 100 ||
        typeof reservation.room !== 'string' || !/^[A-Za-z0-9-]{1,8}$/.test(reservation.room) ||
        !validDate(reservation.checkIn) ||
        !validDate(reservation.checkOut) ||
        reservation.checkOut <= reservation.checkIn ||
        !Number.isInteger(reservation.guests) || reservation.guests < 1 || reservation.guests > 20 ||
        !VALID_STATUSES.has(reservation.status)) {
      throw httpError(400, 'The reservation list contains an invalid record.');
    }
    ids.add(reservation.id);
  }
  const active = reservations.filter((reservation) => reservation.status !== 'Cancelled')
    .sort((left, right) => left.room.localeCompare(right.room) || left.checkIn.localeCompare(right.checkIn));
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1];
    const current = active[index];
    if (previous.room === current.room && previous.checkOut > current.checkIn) {
      throw httpError(409, `Room ${current.room} has overlapping reservations.`);
    }
  }
}

function validateAssignedRooms(reservations, roomAssignments) {
  const availableRooms = new Map(roomAssignments.map((room) => [
    room.room.toUpperCase(),
    { roomType: room.roomType, capacity: room.capacity }
  ]));
  const today = propertyDateKey();
  for (const reservation of reservations) {
    if (reservation.status === 'Cancelled' || reservation.status === 'Checked out' || reservation.checkOut < today) continue;
    const room = availableRooms.get(reservation.room.toUpperCase());
    if (!room || room.roomType !== reservation.roomType || reservation.guests > room.capacity) {
      throw httpError(409, `Room ${reservation.room} is not available for this reservation.`);
    }
  }
}

function validateProfile(profile) {
  if (!profile || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.trim().length > 80 ||
      typeof profile.position !== 'string' || !profile.position.trim() || profile.position.trim().length > 80) {
    throw httpError(400, 'Enter a valid administrator name and position.');
  }
}

function validateActivity(activity) {
  if (!Array.isArray(activity) || activity.length > 500) {
    throw httpError(400, 'Activity history must contain no more than 500 records.');
  }
  for (const entry of activity) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id) ||
        typeof entry.actor !== 'string' || entry.actor.length > 80 ||
        typeof entry.email !== 'string' || entry.email.length > 191 ||
        typeof entry.action !== 'string' || entry.action.length > 120 ||
        typeof entry.details !== 'string' || entry.details.length > 1000 ||
        typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp))) {
      throw httpError(400, 'Activity history contains an invalid record.');
    }
  }
}

async function withTransaction(expectedRevision, callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [lockRows] = await connection.execute('SELECT revision FROM app_lock WHERE id = 1 FOR UPDATE');
    const currentRevision = Number(lockRows[0].revision);
    if (expectedRevision !== currentRevision) {
      throw httpError(409, 'Hotel records changed in another session. The latest records have been reloaded; please try again.');
    }
    const result = await callback(connection);
    await connection.execute('UPDATE app_lock SET revision = revision + 1 WHERE id = 1');
    await connection.commit();
    return { result, revision: currentRevision + 1 };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function replaceRooms(connection, roomTypes) {
  await connection.execute('DELETE FROM room_types');
  for (const type of roomTypes) {
    const [result] = await connection.execute(
      'INSERT INTO room_types (name, nightly_rate, capacity) VALUES (?, ?, ?)',
      [type.name.trim(), type.rate, type.capacity]
    );
    for (const room of type.rooms) {
      await connection.execute('INSERT INTO rooms (room_number, room_type_id) VALUES (?, ?)', [
        String(room).trim().toUpperCase(),
        result.insertId
      ]);
    }
  }
}

async function replaceReservations(connection, reservations) {
  await connection.execute('DELETE FROM reservations');
  for (const reservation of reservations) {
    await connection.execute(
      `INSERT INTO reservations
        (id, guest_name, email, phone, room_type, room_number, check_in, check_out, guests, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reservation.id, reservation.guest.trim(), reservation.email.trim().toLowerCase(),
        reservation.phone, reservation.roomType, reservation.room,
        reservation.checkIn, reservation.checkOut, reservation.guests, reservation.status
      ]
    );
  }
}

async function replaceActivity(connection, activity) {
  await connection.execute('DELETE FROM admin_activity');
  for (const entry of activity) {
    await connection.execute(
      'INSERT INTO admin_activity (id, actor, email, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, entry.actor, entry.email, entry.action, entry.details, entry.timestamp]
    );
  }
}

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const admin = email ? await findAdmin(email) : null;
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: 'That email and password don’t match an admin account.' });
    }
    res.cookie(SESSION_COOKIE, createSession(admin.email), cookieOptions(SESSION_DURATION_MS));
    res.json({ admin: publicAdmin(admin) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/session', async (req, res, next) => {
  try {
    const email = verifySession(sessionCookie(req));
    const admin = email ? await findAdmin(email) : null;
    res.json({ admin: admin ? publicAdmin(admin) : null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOptions(0));
  res.status(204).end();
});

app.get('/api/state', requireAdmin, async (req, res, next) => {
  try {
    const [[reservationRows], [typeRows], [roomRows], [adminRows], [activityRows], [lockRows]] = await Promise.all([
      pool.execute("SELECT id, guest_name AS guest, email, phone, room_type AS roomType, room_number AS room, DATE_FORMAT(check_in, '%Y-%m-%d') AS checkIn, DATE_FORMAT(check_out, '%Y-%m-%d') AS checkOut, guests, status FROM reservations ORDER BY check_in, id"),
      pool.execute('SELECT id, name, nightly_rate AS rate, capacity FROM room_types ORDER BY id'),
      pool.execute('SELECT room_number, room_type_id FROM rooms ORDER BY room_number'),
      pool.execute('SELECT email, name, position FROM admin_accounts ORDER BY name'),
      pool.execute('SELECT id, actor, email, action, details, created_at AS timestamp FROM admin_activity ORDER BY created_at DESC LIMIT 500'),
      pool.execute('SELECT revision FROM app_lock WHERE id = 1')
    ]);
    const roomsByType = new Map();
    for (const room of roomRows) {
      if (!roomsByType.has(room.room_type_id)) roomsByType.set(room.room_type_id, []);
      roomsByType.get(room.room_type_id).push(room.room_number);
    }
    res.json({
      reservations: reservationRows,
      roomTypes: typeRows.map((type) => ({
        name: type.name,
        rate: Number(type.rate),
        capacity: type.capacity,
        rooms: roomsByType.get(type.id) || []
      })),
      administrator: { name: req.admin.name, position: req.admin.position },
      adminAccounts: adminRows,
      activityHistory: activityRows,
      revision: Number(lockRows[0].revision)
    });
  } catch (error) {
    next(error);
  }
});

app.put('/api/reservations', requireAdmin, async (req, res, next) => {
  try {
    validateReservations(req.body?.reservations);
    const { revision } = await withTransaction(req.body.revision, async (connection) => {
      const [roomRows] = await connection.execute(
        'SELECT r.room_number AS room, rt.name AS roomType, rt.capacity FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id'
      );
      validateAssignedRooms(req.body.reservations, roomRows);
      await replaceReservations(connection, req.body.reservations);
    });
    res.json({ revision });
  } catch (error) {
    next(error);
  }
});

app.put('/api/rooms', requireAdmin, async (req, res, next) => {
  try {
    validateRoomTypes(req.body?.roomTypes);
    const { revision } = await withTransaction(req.body.revision, async (connection) => {
      const [activeStays] = await connection.execute(
        "SELECT room_number, room_type, guests, DATE_FORMAT(check_out, '%Y-%m-%d') AS check_out FROM reservations WHERE status IN ('Reserved', 'Checked in')"
      );
      const today = propertyDateKey();
      const configuredRooms = new Map(req.body.roomTypes.flatMap((type) =>
        type.rooms.map((room) => [String(room).trim().toUpperCase(), { roomType: type.name.trim(), capacity: type.capacity }])
      ));
      if (activeStays.filter((stay) => stay.check_out >= today).some((stay) => {
        const room = configuredRooms.get(stay.room_number);
        return !room || room.roomType !== stay.room_type || stay.guests > room.capacity;
      })) {
        throw httpError(409, 'Rooms assigned to current or upcoming stays cannot be removed or changed.');
      }
      await replaceRooms(connection, req.body.roomTypes);
    });
    res.json({ revision });
  } catch (error) {
    next(error);
  }
});

app.put('/api/profile', requireAdmin, async (req, res, next) => {
  try {
    validateProfile(req.body?.profile);
    const profile = req.body.profile;
    await pool.execute('UPDATE admin_accounts SET name = ?, position = ? WHERE email = ?', [
      profile.name.trim(), profile.position.trim(), req.admin.email
    ]);
    res.json({ name: profile.name.trim(), position: profile.position.trim() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/accounts', requireAdmin, async (req, res, next) => {
  try {
    const { name, position, email, password } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 ||
        typeof position !== 'string' || !position.trim() || position.trim().length > 80 ||
        typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 191 ||
        typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw httpError(400, 'Enter a valid name, position, email, and password (8–128 characters).');
    }
    const hash = await bcrypt.hash(password, 12);
    await pool.execute(
      'INSERT INTO admin_accounts (email, name, position, password_hash) VALUES (?, ?, ?, ?)',
      [email.trim().toLowerCase(), name.trim(), position.trim(), hash]
    );
    res.status(201).json({ name: name.trim(), position: position.trim(), email: email.trim().toLowerCase() });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return next(httpError(409, 'An admin already uses that email address.'));
    next(error);
  }
});

app.post('/api/activity', requireAdmin, async (req, res, next) => {
  try {
    const entry = req.body?.entry;
    validateActivity([entry]);
    await pool.execute(
      'INSERT INTO admin_activity (id, actor, email, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [entry.id, req.admin.name, req.admin.email, entry.action, entry.details, entry.timestamp]
    );
    await pool.execute(
      'DELETE FROM admin_activity WHERE id NOT IN (SELECT id FROM (SELECT id FROM admin_activity ORDER BY created_at DESC LIMIT 500) recent)'
    );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.put('/api/restore', requireAdmin, async (req, res, next) => {
  try {
    const { reservations, roomTypes, activityHistory, administrator } = req.body || {};
    validateReservations(reservations);
    validateRoomTypes(roomTypes);
    const roomAssignments = roomTypes.flatMap((type) => type.rooms.map((room) => ({
      room: String(room).trim().toUpperCase(),
      roomType: type.name.trim(),
      capacity: type.capacity
    })));
    validateAssignedRooms(reservations, roomAssignments);
    validateActivity(activityHistory);
    validateProfile(administrator);
    const { revision } = await withTransaction(req.body.revision, async (connection) => {
      await replaceRooms(connection, roomTypes);
      await replaceReservations(connection, reservations);
      await replaceActivity(connection, activityHistory);
      await connection.execute('UPDATE admin_accounts SET name = ?, position = ? WHERE email = ?', [
        administrator.name.trim(), administrator.position.trim(), req.admin.email
      ]);
    });
    res.json({ revision });
  } catch (error) {
    next(error);
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'A record with those details already exists.' });
  }
  if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_ROW_IS_REFERENCED_2') {
    return res.status(409).json({ error: 'The change conflicts with existing hotel records.' });
  }
  const status = error.status || 500;
  if (status >= 500) console.error('Request failed:', error);
  res.status(status).json({ error: status >= 500 ? 'The server could not complete the request.' : error.message });
});

async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    for (const statement of schema.split(';').map((value) => value.trim()).filter(Boolean)) {
      await connection.query(statement);
    }
    const [typeRows] = await connection.query('SELECT COUNT(*) AS count FROM room_types');
    if (Number(typeRows[0].count) === 0) {
      for (const roomType of DEFAULT_ROOM_TYPES) {
        const [result] = await connection.execute(
          'INSERT INTO room_types (name, nightly_rate, capacity) VALUES (?, ?, ?)',
          [roomType.name, roomType.rate, roomType.capacity]
        );
        for (const room of roomType.rooms) {
          await connection.execute('INSERT INTO rooms (room_number, room_type_id) VALUES (?, ?)', [room, result.insertId]);
        }
      }
    }
    const [admins] = await connection.query('SELECT COUNT(*) AS count FROM admin_accounts');
    if (Number(admins[0].count) === 0) {
      const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
      const password = process.env.ADMIN_PASSWORD;
      if (!email || !password || password.length < 12) {
        throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters to create the first administrator.');
      }
      const passwordHash = await bcrypt.hash(password, 12);
      await connection.execute(
        'INSERT INTO admin_accounts (email, name, position, password_hash) VALUES (?, ?, ?, ?)',
        [
          email,
          process.env.ADMIN_NAME?.trim() || 'Alex Morgan',
          process.env.ADMIN_POSITION?.trim() || 'Front desk administrator',
          passwordHash
        ]
      );
      console.log(`Created the initial administrator account for ${email}.`);
    }
  } finally {
    connection.release();
  }
}

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`The Aster is available at http://localhost:${PORT}`));
  })
  .catch(async (error) => {
    console.error('Could not initialize the MySQL database:', error.message);
    await pool.end();
    process.exitCode = 1;
  });
