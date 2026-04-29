const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const db = new Database('ayes2026.db');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'ayes2026-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('选手', '组委')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS registration_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_text TEXT UNIQUE NOT NULL,
        used INTEGER DEFAULT 0,
        used_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (used_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        capacity INTEGER NOT NULL,
        enrolled INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (course_id) REFERENCES courses(id),
        UNIQUE(user_id, course_id)
    );
`);

const courseInit = db.prepare('SELECT COUNT(*) as count FROM courses').get();
if (courseInit.count === 0) {
    const insertCourse = db.prepare('INSERT INTO courses (name, description, capacity) VALUES (?, ?, ?)');
    insertCourse.run('算法竞赛基础', '算法竞赛入门课程', 30);
    insertCourse.run('数据结构进阶', '高级数据结构与应用', 25);
    insertCourse.run('ACM实战训练', 'ACM竞赛实战训练', 20);
    insertCourse.run('算法思维培养', '算法思维与问题解决', 35);
    insertCourse.run('动态规划专题', 'DP专项训练', 28);
}

app.get('/api/courses', (req, res) => {
    const courses = db.prepare('SELECT * FROM courses').all();
    res.json(courses);
});

app.get('/api/my-courses', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '请先登录' });
    }
    const enrollments = db.prepare(`
        SELECT c.*, e.enrolled_at 
        FROM enrollments e 
        JOIN courses c ON e.course_id = c.id 
        WHERE e.user_id = ?
    `).all(req.session.userId);
    res.json(enrollments);
});

app.post('/api/enroll', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '请先登录' });
    }
    const { courseId } = req.body;
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
    if (!course) {
        return res.status(404).json({ error: '课程不存在' });
    }
    const existing = db.prepare('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?').get(req.session.userId, courseId);
    if (existing) {
        return res.status(400).json({ error: '您已选修此课程' });
    }
    if (course.enrolled >= course.capacity) {
        return res.status(400).json({ error: '课程已满，选课失败' });
    }
    db.prepare('INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)').run(req.session.userId, courseId);
    db.prepare('UPDATE courses SET enrolled = enrolled + 1 WHERE id = ?').run(courseId);
    res.json({ success: true, message: '选课成功' });
});

app.post('/api/cancel-enroll', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '请先登录' });
    }
    const { courseId } = req.body;
    const existing = db.prepare('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?').get(req.session.userId, courseId);
    if (!existing) {
        return res.status(400).json({ error: '您未选修此课程' });
    }
    db.prepare('DELETE FROM enrollments WHERE user_id = ? AND course_id = ?').run(req.session.userId, courseId);
    db.prepare('UPDATE courses SET enrolled = enrolled - 1 WHERE id = ?').run(courseId);
    res.json({ success: true, message: '退课成功' });
});

app.post('/api/apply-key', (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ error: '请提供用户名' });
    }
    const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existingUser) {
        return res.status(400).json({ error: '用户名已存在' });
    }
    const key = uuidv4().substring(0, 8).toUpperCase();
    db.prepare('INSERT INTO registration_keys (key_text, used) VALUES (?, 0)').run(key);
    res.json({ 
        success: true, 
        key: key,
        message: '密钥生成成功，请支付报名费后使用此密钥注册'
    });
});

app.post('/api/register', (req, res) => {
    const { username, password, role, key } = req.body;
    if (!username || !password || !role || !key) {
        return res.status(400).json({ error: '请填写所有字段' });
    }
    if (!['选手', '组委'].includes(role)) {
        return res.status(400).json({ error: '角色无效' });
    }
    const keyRecord = db.prepare('SELECT * FROM registration_keys WHERE key_text = ? AND used = 0').get(key);
    if (!keyRecord) {
        return res.status(400).json({ error: '密钥无效或已被使用' });
    }
    const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existingUser) {
        return res.status(400).json({ error: '用户名已存在' });
    }
    const result = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, password, role);
    db.prepare('UPDATE registration_keys SET used = 1, used_by = ? WHERE key_text = ?').run(result.lastInsertRowid, key);
    res.json({ success: true, message: '注册成功' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
    if (!user) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ 
        success: true, 
        user: { id: user.id, username: user.username, role: user.role }
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/session', (req, res) => {
    if (req.session.userId) {
        res.json({ 
            loggedIn: true, 
            user: { 
                id: req.session.userId, 
                username: req.session.username, 
                role: req.session.role 
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

app.get('/api/admin/keys', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可查看密钥' });
    }
    const keys = db.prepare(`
        SELECT rk.*, u.username 
        FROM registration_keys rk 
        LEFT JOIN users u ON rk.used_by = u.id
    `).all();
    res.json(keys);
});

app.get('/api/admin/users', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可查看用户' });
    }
    const users = db.prepare(`
        SELECT u.id, u.username, u.role, u.created_at,
               COUNT(e.id) as course_count
        FROM users u
        LEFT JOIN enrollments e ON u.id = e.user_id
        GROUP BY u.id
    `).all();
    res.json(users);
});

app.listen(3000, () => {
    console.log('服务器运行在 http://localhost:3000');
});
