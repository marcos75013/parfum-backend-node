import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Resend } from 'resend';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();

// =========================
// ⚙️ CONFIG
// =========================

const PORT = Number(process.env.PORT || 3000);
const APP_NAME = process.env.APP_NAME || 'Escale Olfactive';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_TO = process.env.MAIL_TO;
const MAIL_TO_BACKUP = process.env.MAIL_TO_BACKUP;
const MAIL_FROM = process.env.MAIL_FROM || 'commandes@escaleolfactive.fr';

// chemins
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cacheFilePath = path.join(__dirname, 'cache.json');
const ordersBackupFilePath = path.join(__dirname, 'orders_backup.json');

// cache mémoire
let cache = new Map();

const resend = new Resend(RESEND_API_KEY);

// =========================
// 🌐 CORS (FIX TOTAL)
// =========================

app.use(
    cors({
        origin: true, // 🔥 autorise tout (évite blocage Vercel)
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    })
);

app.use(express.json());

// =========================
// 🛡️ RATE LIMIT
// =========================

const orderLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
});

// =========================
// 📦 CACHE
// =========================

function loadCacheFromFile() {
    try {
        if (!fs.existsSync(cacheFilePath)) {
            fs.writeFileSync(cacheFilePath, JSON.stringify({}, null, 2));
        }

        const parsed = JSON.parse(fs.readFileSync(cacheFilePath));
        cache = new Map(Object.entries(parsed));

        console.log(`✅ Cache chargé : ${cache.size}`);
    } catch {
        cache = new Map();
    }
}

function saveCacheToFile() {
    fs.writeFileSync(
        cacheFilePath,
        JSON.stringify(Object.fromEntries(cache), null, 2)
    );
}

function backupOrder(order) {
    fs.appendFileSync(
        ordersBackupFilePath,
        JSON.stringify(order) + '\n'
    );
}

loadCacheFromFile();

// =========================
// 🧠 UTILS
// =========================

function formatPrice(v) {
    return `${Number(v || 0).toFixed(2)} €`;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function forceHttps(url) {
    return url?.replace('http://', 'https://');
}

// 🔥 nettoyage intelligent des noms
function cleanName(str = '') {
    return str
        .replace(/\+/g, ' ')
        .replace(/\d+\s?ml/gi, '')
        .replace(/miniature/gi, '')
        .replace(/coffret/gi, '')
        .replace(/eau de parfum|edp|edt/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// =========================
// 📧 EMAIL
// =========================

async function sendOrderEmail(order) {
    const { customer, items, total } = order;

    const subject = `Commande ${APP_NAME} - ${customer.firstName} ${customer.lastName}`;

    const recipients = MAIL_TO_BACKUP
        ? [MAIL_TO, MAIL_TO_BACKUP]
        : [MAIL_TO];

    const html = `
    <h2>Nouvelle commande ${APP_NAME}</h2>
    <p><b>Client :</b> ${customer.firstName} ${customer.lastName}</p>
    <p><b>Email :</b> ${customer.email}</p>

    <h3>Produits :</h3>
    ${items
        .map(
            (i) =>
                `<p>${i.parfum.name} x${i.quantity} = ${formatPrice(
                    i.parfum.price * i.quantity
                )}</p>`
        )
        .join('')}

    <h2>Total : ${formatPrice(total)}</h2>
  `;

    const { error } = await resend.emails.send({
        from: MAIL_FROM,
        to: recipients,
        replyTo: customer.email,
        subject,
        html,
    });

    if (error) throw new Error(error.message);
}

// =========================
// 🚀 ROUTES
// =========================

app.get('/api/perfumes/image', async (req, res) => {
    const { name, brand } = req.query;

    if (!name) return res.status(400).json({ error: 'Missing name' });

    const clean = cleanName(name);
    const key = `${brand}_${clean}`;

    if (cache.has(key)) {
        return res.json({ imageUrl: cache.get(key) });
    }

    try {
        const query = `${brand || ''} ${clean} perfume bottle`;

        console.log('🔎 Recherche image:', query);

        const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`;

        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
            },
        });

        const $ = cheerio.load(data);
        const results = [];

        $('.iusc').each((_, el) => {
            const m = $(el).attr('m');
            if (m) {
                try {
                    const meta = JSON.parse(m);
                    if (meta.murl) results.push(meta.murl);
                } catch {}
            }
        });

        let image = results[0];

        if (!image) {
            console.log('⚠️ Aucune image trouvée, fallback');
            image = `https://picsum.photos/600?random=${Math.random()}`;
        }

        image = forceHttps(image);

        cache.set(key, image);
        saveCacheToFile();

        res.json({ imageUrl: image });
    } catch (e) {
        console.error('❌ Erreur image:', e.message);

        res.json({
            imageUrl: `https://picsum.photos/600?random=${Math.random()}`,
        });
    }
});

app.post('/api/order', orderLimiter, async (req, res) => {
    try {
        const { customer, items, total } = req.body;

        if (!customer || !items?.length) {
            return res.status(400).json({ error: 'Invalid data' });
        }

        if (!isValidEmail(customer.email)) {
            return res.status(400).json({ error: 'Invalid email' });
        }

        try {
            await sendOrderEmail(req.body);
        } catch (e) {
            console.error('Email failed:', e);
            backupOrder(req.body);
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================
// ▶️ START
// =========================

app.listen(PORT, () => {
    console.log(`🚀 ${APP_NAME} backend running on ${PORT}`);
});