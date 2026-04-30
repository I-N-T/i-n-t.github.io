const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
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
        name TEXT,
        school TEXT,
        phone TEXT,
        email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS exam_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const examInit = db.prepare('SELECT COUNT(*) as count FROM exam_links').get();
if (examInit.count === 0) {
    db.prepare('INSERT INTO exam_links (title, url) VALUES (?, ?)').run(
        'AYES 2026 笔试链接',
        'https://example.com/exam'
    );
}

app.get('/api/exam-links', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '请先登录' });
    }
    const links = db.prepare('SELECT * FROM exam_links WHERE active = 1').all();
    res.json(links);
});

app.post('/api/register', (req, res) => {
    const { username, password, role, name, school, phone, email } = req.body;
    if (!username || !password || !role) {
        return res.status(400).json({ error: '请填写必填字段' });
    }
    if (!['选手', '组委'].includes(role)) {
        return res.status(400).json({ error: '角色无效' });
    }
    const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existingUser) {
        return res.status(400).json({ error: '用户名已存在' });
    }
    db.prepare('INSERT INTO users (username, password, role, name, school, phone, email) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(username, password, role, name, school, phone, email);
    
    if (role === '选手') {
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        db.prepare('INSERT INTO notifications (user_id, title, content) VALUES (?, ?, ?)')
            .run(user.id, '欢迎报名', '欢迎报名AYES 2026！请登录后查看笔试链接。');
    }
    
    res.json({ success: true, message: '注册成功' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: '请填写用户名和密码' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
    if (!user) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({
        success: true,
        user: { id: user.id, username: user.username, role: user.role, name: user.name }
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

app.get('/api/notifications', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '请先登录' });
    }
    const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
    res.json(notifications);
});

app.post('/api/mark-notification-read', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: '请先登录' });
    }
    const { notificationId } = req.body;
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(notificationId, req.session.userId);
    res.json({ success: true });
});

app.get('/api/admin/participants', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可访问' });
    }
    const participants = db.prepare(`
        SELECT u.*, COUNT(n.id) as unread_count
        FROM users u
        LEFT JOIN notifications n ON u.id = n.user_id AND n.read = 0
        WHERE u.role = '选手'
        GROUP BY u.id
        ORDER BY u.created_at DESC
    `).all();
    res.json(participants);
});

app.post('/api/admin/send-notification', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可发送通知' });
    }
    const { userId, title, content } = req.body;
    db.prepare('INSERT INTO notifications (user_id, title, content) VALUES (?, ?, ?)').run(userId, title, content);
    res.json({ success: true, message: '通知发送成功' });
});

app.post('/api/admin/broadcast-notification', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可发送通知' });
    }
    const { title, content } = req.body;
    const participants = db.prepare('SELECT id FROM users WHERE role = ?').all('选手');
    participants.forEach(p => {
        db.prepare('INSERT INTO notifications (user_id, title, content) VALUES (?, ?, ?)').run(p.id, title, content);
    });
    res.json({ success: true, message: `已向 ${participants.length} 位选手发送通知` });
});

app.get('/api/admin/exam-links', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可访问' });
    }
    const links = db.prepare('SELECT * FROM exam_links ORDER BY created_at DESC').all();
    res.json(links);
});

app.post('/api/admin/exam-links', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可操作' });
    }
    const { title, url } = req.body;
    db.prepare('INSERT INTO exam_links (title, url) VALUES (?, ?)').run(title, url);
    res.json({ success: true, message: '笔试链接添加成功' });
});

app.put('/api/admin/exam-links/:id', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可操作' });
    }
    const { title, url, active } = req.body;
    db.prepare('UPDATE exam_links SET title = ?, url = ?, active = ? WHERE id = ?').run(title, url, active, req.params.id);
    res.json({ success: true, message: '笔试链接更新成功' });
});

app.delete('/api/admin/exam-links/:id', (req, res) => {
    if (!req.session.userId || req.session.role !== '组委') {
        return res.status(403).json({ error: '仅组委可操作' });
    }
    db.prepare('DELETE FROM exam_links WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: '笔试链接删除成功' });
});

app.listen(3000, () => {
    console.log('服务器运行在 http://localhost:3000');
});
