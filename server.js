require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, 'vitalsync-db.json');
const INDEX_PATH = path.join(__dirname, 'index.html');
const IMAGE_PATH = path.join(__dirname, 'image.png');
const COOKIE_NAME = 'vitalsync_session';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@example.com';
const MONGODB_URI = process.env.MONGODB_URI || '';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const jwtSecret = process.env.JWT_SECRET || (!isProduction ? crypto.randomBytes(32).toString('hex') : '');
if (!jwtSecret) {
  throw new Error('JWT_SECRET is required in production.');
}
if (isProduction && !MONGODB_URI) {
  throw new Error('MONGODB_URI is required in production.');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const initialDb = {
  nextUserId: 1,
  nextRecordId: 1,
  users: [],
  periods: [],
  diaryEntries: [],
  pcodResults: [],
  chatMessages: [],
};

let writeQueue = Promise.resolve();
let mongoClient = null;
let mongoDatabase = null;

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function sanitizeString(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function sanitizeConditions(conditions) {
  return Array.isArray(conditions)
    ? conditions.map((item) => sanitizeString(item, 80)).filter(Boolean).slice(0, 20)
    : [];
}

function clampNumber(value, min, max, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function publicUser(user) {
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    age: user.age,
    weight: user.weight,
    lastPeriod: user.lastPeriod,
    cycleLength: user.cycleLength,
    conditions: user.conditions || [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function sessionCookieOptions(req) {
  const secure = isProduction || req.secure || req.headers['x-forwarded-proto'] === 'https';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function signSession(userId) {
  return jwt.sign({ userId: String(userId) }, jwtSecret, { expiresIn: '7d' });
}

function setSession(res, req, userId) {
  res.cookie(COOKIE_NAME, signSession(userId), sessionCookieOptions(req));
}

function clearSession(res, req) {
  res.clearCookie(COOKIE_NAME, { ...sessionCookieOptions(req), maxAge: undefined });
}

function readJsonDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDb, null, 2));
  }

  const raw = fs.readFileSync(DB_PATH, 'utf8');
  if (!raw.trim()) {
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDb, null, 2));
    return { ...initialDb };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse JSON database at ${DB_PATH}: ${error.message}`);
  }

  return {
    ...initialDb,
    ...parsed,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    periods: Array.isArray(parsed.periods) ? parsed.periods : [],
    diaryEntries: Array.isArray(parsed.diaryEntries) ? parsed.diaryEntries : [],
    pcodResults: Array.isArray(parsed.pcodResults) ? parsed.pcodResults : [],
    chatMessages: Array.isArray(parsed.chatMessages) ? parsed.chatMessages : [],
  };
}

async function writeJsonDbAtomic(db) {
  const tempPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(db, null, 2), 'utf8');
  try {
    await fs.promises.rename(tempPath, DB_PATH);
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') {
      throw error;
    }
    await fs.promises.copyFile(tempPath, DB_PATH);
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

function withJsonDb(mutator) {
  const run = async () => {
    const db = readJsonDb();
    const result = await mutator(db);
    await writeJsonDbAtomic(db);
    return result;
  };

  writeQueue = writeQueue.then(run, run);
  return writeQueue;
}

function nextJsonId(db) {
  const id = db.nextRecordId || 1;
  db.nextRecordId = id + 1;
  return id;
}

function renderPolicyPage({ title, intro, sections }) {
  const sectionHtml = sections.map((section) => `
    <h2>${section.heading}</h2>
    <p>${section.body}</p>
  `).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: Georgia, serif; background: #fff8f8; color: #3c1a30; line-height: 1.65; }
    main { max-width: 760px; margin: 0 auto; padding: 48px 20px 72px; }
    h1, h2 { color: #6d214f; }
    a { color: #c94a62; }
    .meta { color: #7b556a; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p class="meta">Last updated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
    <p>${intro}</p>
    ${sectionHtml}
    <h2>Contact</h2>
    <p>Support: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
    <p><a href="${APP_BASE_URL}">Back to VitalSync</a></p>
  </main>
</body>
</html>`;
}

async function connectMongo() {
  if (!MONGODB_URI) return null;
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  mongoDatabase = mongoClient.db();

  await Promise.all([
    mongoDatabase.collection('users').createIndex({ email: 1 }, { unique: true }),
    mongoDatabase.collection('periods').createIndex({ userId: 1, date: 1 }),
    mongoDatabase.collection('diaryEntries').createIndex({ userId: 1, date: 1 }, { unique: true }),
    mongoDatabase.collection('pcodResults').createIndex({ userId: 1, date: -1 }),
    mongoDatabase.collection('chatMessages').createIndex({ userId: 1, createdOrder: 1 }),
  ]);

  return mongoDatabase;
}

function toObjectId(id) {
  if (!ObjectId.isValid(String(id || ''))) return null;
  return new ObjectId(String(id));
}

function serializeMongoUser(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    passwordHash: doc.passwordHash,
    age: doc.age ?? null,
    weight: doc.weight ?? null,
    lastPeriod: doc.lastPeriod,
    cycleLength: doc.cycleLength,
    conditions: Array.isArray(doc.conditions) ? doc.conditions : [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const dbApi = {
  async init() {
    if (MONGODB_URI) {
      await connectMongo();
      console.log('Database adapter: MongoDB');
    } else {
      readJsonDb();
      console.log(`Database adapter: JSON file (${DB_PATH})`);
    }
  },

  async getUserById(userId) {
    if (mongoDatabase) {
      const objectId = toObjectId(userId);
      if (!objectId) return null;
      return serializeMongoUser(await mongoDatabase.collection('users').findOne({ _id: objectId }));
    }

    const db = readJsonDb();
    const user = db.users.find((item) => String(item.id) === String(userId));
    return user ? { ...user, id: String(user.id) } : null;
  },

  async getUserByEmail(email) {
    const cleanEmail = normalizeEmail(email);
    if (mongoDatabase) {
      return serializeMongoUser(await mongoDatabase.collection('users').findOne({ email: cleanEmail }));
    }

    const db = readJsonDb();
    const user = db.users.find((item) => item.email === cleanEmail);
    return user ? { ...user, id: String(user.id) } : null;
  },

  async createUser(data) {
    if (mongoDatabase) {
      const document = {
        name: data.name,
        email: data.email,
        passwordHash: data.passwordHash,
        age: data.age,
        weight: data.weight,
        lastPeriod: data.lastPeriod,
        cycleLength: data.cycleLength,
        conditions: data.conditions,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
      const result = await mongoDatabase.collection('users').insertOne(document);
      return { ...document, id: result.insertedId.toString() };
    }

    return withJsonDb((db) => {
      if (db.users.some((item) => item.email === data.email)) {
        const error = new Error('duplicate');
        error.code = 'duplicate';
        throw error;
      }

      const user = {
        id: db.nextUserId++,
        ...data,
      };
      db.users.push(user);
      return { ...user, id: String(user.id) };
    });
  },

  async updateUser(userId, updates) {
    if (mongoDatabase) {
      const objectId = toObjectId(userId);
      await mongoDatabase.collection('users').updateOne(
        { _id: objectId },
        { $set: updates }
      );
      return this.getUserById(userId);
    }

    return withJsonDb((db) => {
      const user = db.users.find((item) => String(item.id) === String(userId));
      Object.assign(user, updates);
      return { ...user, id: String(user.id) };
    });
  },

  async addPeriod(userId, period) {
    if (mongoDatabase) {
      await mongoDatabase.collection('periods').insertOne({
        userId: String(userId),
        date: period.date,
        flow: period.flow,
        logged: period.logged,
      });
      return;
    }

    await withJsonDb((db) => {
      const duplicate = db.periods.find((item) =>
        String(item.userId) === String(userId) && item.date === period.date && item.flow === period.flow
      );
      if (!duplicate) {
        db.periods.push({
          id: nextJsonId(db),
          userId: String(userId),
          date: period.date,
          flow: period.flow,
          logged: period.logged,
        });
      }
    });
  },

  async upsertDiary(userId, entry) {
    if (mongoDatabase) {
      await mongoDatabase.collection('diaryEntries').updateOne(
        { userId: String(userId), date: entry.date },
        { $set: { ...entry, userId: String(userId) } },
        { upsert: true }
      );
      return;
    }

    await withJsonDb((db) => {
      const existing = db.diaryEntries.find((item) => String(item.userId) === String(userId) && item.date === entry.date);
      const nextEntry = {
        id: existing ? existing.id : nextJsonId(db),
        userId: String(userId),
        ...entry,
      };
      if (existing) Object.assign(existing, nextEntry);
      else db.diaryEntries.push(nextEntry);
    });
  },

  async addPcodResult(userId, result) {
    if (mongoDatabase) {
      await mongoDatabase.collection('pcodResults').insertOne({
        userId: String(userId),
        answers: result.answers,
        score: result.score,
        date: result.date,
      });
      return;
    }

    await withJsonDb((db) => {
      db.pcodResults.push({
        id: nextJsonId(db),
        userId: String(userId),
        answers: result.answers,
        score: result.score,
        date: result.date,
      });
    });
  },

  async addChatMessage(userId, message) {
    if (mongoDatabase) {
      await mongoDatabase.collection('chatMessages').insertOne({
        userId: String(userId),
        role: message.role,
        content: message.content,
        time: message.time,
        createdOrder: Date.now() + Math.random(),
      });
      return;
    }

    await withJsonDb((db) => {
      db.chatMessages.push({
        id: nextJsonId(db),
        userId: String(userId),
        role: message.role,
        content: message.content,
        time: message.time,
      });
    });
  },

  async deleteUserData(userId) {
    if (mongoDatabase) {
      await Promise.all([
        mongoDatabase.collection('users').deleteOne({ _id: toObjectId(userId) }),
        mongoDatabase.collection('periods').deleteMany({ userId: String(userId) }),
        mongoDatabase.collection('diaryEntries').deleteMany({ userId: String(userId) }),
        mongoDatabase.collection('pcodResults').deleteMany({ userId: String(userId) }),
        mongoDatabase.collection('chatMessages').deleteMany({ userId: String(userId) }),
      ]);
      return;
    }

    await withJsonDb((db) => {
      db.users = db.users.filter((item) => String(item.id) !== String(userId));
      db.periods = db.periods.filter((item) => String(item.userId) !== String(userId));
      db.diaryEntries = db.diaryEntries.filter((item) => String(item.userId) !== String(userId));
      db.pcodResults = db.pcodResults.filter((item) => String(item.userId) !== String(userId));
      db.chatMessages = db.chatMessages.filter((item) => String(item.userId) !== String(userId));
    });
  },

  async getUserData(userId) {
    const user = await this.getUserById(userId);
    if (!user) return null;

    if (mongoDatabase) {
      const [periods, diary, pcod, chat] = await Promise.all([
        mongoDatabase.collection('periods').find({ userId: String(userId) }).sort({ date: 1 }).toArray(),
        mongoDatabase.collection('diaryEntries').find({ userId: String(userId) }).sort({ date: 1 }).toArray(),
        mongoDatabase.collection('pcodResults').find({ userId: String(userId) }).sort({ date: -1 }).limit(1).toArray(),
        mongoDatabase.collection('chatMessages').find({ userId: String(userId) }).sort({ createdOrder: 1 }).toArray(),
      ]);

      return {
        user: publicUser(user),
        periods: periods.map(({ _id, ...item }) => item),
        diary: diary.map(({ _id, userId: _userId, ...item }) => item),
        pcod: pcod[0] ? { answers: pcod[0].answers, score: pcod[0].score, date: pcod[0].date } : null,
        chat: chat.map(({ role, content, time }) => ({ role, content, time })),
      };
    }

    const db = readJsonDb();
    return {
      user: publicUser(user),
      periods: db.periods
        .filter((item) => String(item.userId) === String(userId))
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(({ id, ...item }) => item),
      diary: db.diaryEntries
        .filter((item) => String(item.userId) === String(userId))
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(({ id, userId: _userId, ...item }) => item),
      pcod: db.pcodResults
        .filter((item) => String(item.userId) === String(userId))
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(({ id, userId: _userId, ...item }) => item)[0] || null,
      chat: db.chatMessages
        .filter((item) => String(item.userId) === String(userId))
        .sort((a, b) => a.id - b.id)
        .map(({ role, content, time }) => ({ role, content, time })),
    };
  },
};

async function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const payload = jwt.verify(token, jwtSecret);
    const user = await dbApi.getUserById(payload.userId);
    if (!user) {
      clearSession(res, req);
      return res.status(401).json({ error: 'Session is no longer valid.' });
    }
    req.user = user;
    next();
  } catch {
    clearSession(res, req);
    res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://cdn.tailwindcss.com',
        'https://unpkg.com',
        'https://cdn.jsdelivr.net',
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://fonts.googleapis.com',
      ],
      fontSrc: [
        "'self'",
        'https://fonts.gstatic.com',
      ],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'https://generativelanguage.googleapis.com', 'https://api.anthropic.com'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

if (PUBLIC_ORIGIN) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', PUBLIC_ORIGIN);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
}

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'vitalsync',
    timestamp: nowIso(),
    environment: process.env.NODE_ENV || 'development',
    database: mongoDatabase ? 'mongodb' : 'json-dev-fallback',
  });
});

app.get('/image.png', (req, res, next) => {
  res.type('png').sendFile(IMAGE_PATH, (error) => {
    if (error) next(error);
  });
});

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.get('/privacy', (req, res, next) => {
  res.type('html').sendFile(path.join(__dirname, 'privacy.html'), (error) => {
    if (error) next(error);
  });
});

app.get('/terms', (req, res, next) => {
  res.type('html').sendFile(path.join(__dirname, 'terms.html'), (error) => {
    if (error) next(error);
  });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const name = sanitizeString(req.body.name, 80);
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const lastPeriod = sanitizeString(req.body.lastPeriod, 10);
  const age = clampNumber(req.body.age, 10, 80, null);
  const weight = clampNumber(req.body.weight, 20, 300, null);
  const cycleLength = clampNumber(req.body.cycleLength, 15, 60, 28);
  const conditions = sanitizeConditions(req.body.conditions);

  if (!name || !isValidEmail(email) || password.length < 8 || !isValidDate(lastPeriod)) {
    return res.status(400).json({
      error: 'Please provide a valid name, email, password of at least 8 characters, and last period date.',
    });
  }

  try {
    const existing = await dbApi.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const user = await dbApi.createUser({
      name,
      email,
      passwordHash: bcrypt.hashSync(password, 12),
      age,
      weight,
      lastPeriod,
      cycleLength,
      conditions,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    setSession(res, req, user.id);
    res.status(201).json({ data: await dbApi.getUserData(user.id) });
  } catch (error) {
    console.error('Registration failed:', error);
    if (error.code === 11000 || error.code === 'duplicate') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = await dbApi.getUserByEmail(email);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  setSession(res, req, user.id);
  res.json({ data: await dbApi.getUserData(user.id) });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(res, req);
  res.status(204).end();
});

app.get('/api/me', requireAuth, async (req, res) => {
  res.json({ data: await dbApi.getUserData(req.user.id) });
});

app.put('/api/me', requireAuth, async (req, res) => {
  const nextName = sanitizeString(req.body.name, 80) || req.user.name;
  const nextAge = clampNumber(req.body.age, 10, 80, null);
  const nextWeight = clampNumber(req.body.weight, 20, 300, null);
  const nextCycleLength = clampNumber(req.body.cycleLength, 15, 60, 28);
  const nextConditions = sanitizeConditions(req.body.conditions);

  await dbApi.updateUser(req.user.id, {
    name: nextName,
    age: nextAge,
    weight: nextWeight,
    cycleLength: nextCycleLength,
    conditions: nextConditions.length ? nextConditions : req.user.conditions,
    updatedAt: nowIso(),
  });

  res.json({ data: await dbApi.getUserData(req.user.id) });
});

app.post('/api/periods', requireAuth, async (req, res) => {
  const date = sanitizeString(req.body.date, 10);
  const flow = sanitizeString(req.body.flow, 20).toLowerCase();
  const allowedFlows = new Set(['light', 'medium', 'heavy']);

  if (!isValidDate(date) || !allowedFlows.has(flow)) {
    return res.status(400).json({ error: 'A valid date and flow value are required.' });
  }

  await dbApi.addPeriod(req.user.id, { date, flow, logged: nowIso() });
  res.status(201).json({ data: await dbApi.getUserData(req.user.id) });
});

app.put('/api/diary/today', requireAuth, async (req, res) => {
  const date = sanitizeString(req.body.date || nowIso().slice(0, 10), 10);
  const mood = Number.isInteger(req.body.mood) ? req.body.mood : null;
  const symptoms = Array.isArray(req.body.symptoms)
    ? req.body.symptoms.map((item) => sanitizeString(item, 40)).filter(Boolean).slice(0, 20)
    : [];
  const energy = clampNumber(req.body.energy, 1, 5, 3);
  const notes = sanitizeString(req.body.notes, 1200);

  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'A valid entry date is required.' });
  }

  await dbApi.upsertDiary(req.user.id, {
    date,
    mood,
    symptoms,
    energy,
    notes,
    updatedAt: nowIso(),
  });

  res.json({ data: await dbApi.getUserData(req.user.id) });
});

app.post('/api/pcod', requireAuth, async (req, res) => {
  const answers = Array.isArray(req.body.answers)
    ? req.body.answers.map((item) => clampNumber(item, 0, 4, 0))
    : [];
  const score = clampNumber(req.body.score, 0, 100, 0);
  const date = sanitizeString(req.body.date || nowIso(), 40);

  if (answers.length !== 20) {
    return res.status(400).json({ error: 'PCOD assessments must include 20 answers.' });
  }

  await dbApi.addPcodResult(req.user.id, { answers, score, date });
  res.status(201).json({ data: await dbApi.getUserData(req.user.id) });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const text = sanitizeString(req.body.message, 1500);
  if (!text) return res.status(400).json({ error: 'Message is required.' });

  await dbApi.addChatMessage(req.user.id, {
    role: 'user',
    content: text,
    time: nowIso(),
  });

  const assistantText = await makeAssistantReply(req.user, text);

  await dbApi.addChatMessage(req.user.id, {
    role: 'assistant',
    content: assistantText,
    time: nowIso(),
  });

  res.status(201).json({ data: await dbApi.getUserData(req.user.id) });
});

app.get('/api/export', requireAuth, async (req, res) => {
  res.json({ ...(await dbApi.getUserData(req.user.id)), exportedAt: nowIso() });
});

app.delete('/api/me/data', requireAuth, async (req, res) => {
  await dbApi.deleteUserData(req.user.id);
  clearSession(res, req);
  res.status(204).end();
});

async function makeAssistantReply(user, text) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const userData = await dbApi.getUserData(user.id);
      const history = (userData?.chat || []).slice(-10).map(({ role, content }) => ({
        role: role === 'user' ? 'user' : 'model',
        parts: [{ text: content }],
      }));

      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

      const chat = model.startChat({
        history,
        generationConfig: {
          maxOutputTokens: 600,
        },
      });

      const systemMessage = `You are VitalSync AI, a compassionate menstrual health assistant. Answer questions about periods, PCOS, hormones, fertility, and wellness. Be warm, non-judgmental, and evidence-based. Never replace a doctor. The user's name is ${user.name}. Keep responses concise but helpful.`;
      
      const result = await chat.sendMessage(`${systemMessage}\n\nUser query: ${text}`);
      const response = result.response.text();
      return sanitizeString(response, 1500) || fallbackReply(text);
    } catch (error) {
      console.error('Gemini API error:', error);
      return fallbackReply(text);
    }
  }

  return fallbackReply(text);
}

function fallbackReply(text) {
  const lower = text.toLowerCase();
  if (lower.includes('late')) {
    return 'Period delays can happen due to stress, travel, diet changes, illness, or hormonal fluctuations. If your period is more than a week late and pregnancy is possible, consider a pregnancy test and follow up with a clinician if delays keep happening.';
  }
  if (lower.includes('pcos') || lower.includes('pcod')) {
    return 'PCOS risk factors can include irregular periods, acne, excess hair growth, and weight changes. This app can help you track patterns, but diagnosis still needs a clinician, usually with labs and sometimes ultrasound.';
  }
  if (lower.includes('eat') || lower.includes('food')) {
    return 'Iron-rich foods, steady hydration, fiber, and anti-inflammatory foods like ginger or turmeric can be helpful during menstruation. If symptoms are severe, personalized advice from a clinician or dietitian is the better path.';
  }
  if (lower.includes('cramp')) {
    return 'Heat, gentle movement, rest, hydration, and appropriate over-the-counter pain relief can help with cramps. If pain is severe, worsening, or disrupting daily life, it is worth getting medical advice.';
  }
  return 'I can help with general menstrual wellness guidance and pattern tracking, but I cannot diagnose conditions. If you share a bit more about what is happening, I can help you think through the common causes and when to seek care.';
}

app.get('/', (req, res) => {
  res.sendFile(INDEX_PATH);
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path === '/privacy' || req.path === '/terms' || req.path === '/health') return next();
  if (path.extname(req.path)) return next();
  return res.sendFile(INDEX_PATH);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

let server = null;

async function start() {
  await dbApi.init();

  server = app.listen(PORT, () => {
    console.log(`VitalSync running at http://localhost:${PORT}`);
    console.log(`Support email: ${SUPPORT_EMAIL}`);
    if (!process.env.JWT_SECRET && !isProduction) {
      console.log('JWT_SECRET not set; using a temporary in-memory development secret.');
    }
  });
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
