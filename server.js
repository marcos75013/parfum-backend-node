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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cacheFilePath = path.join(__dirname, 'cache.json');
const ordersBackupFilePath = path.join(__dirname, 'orders_backup.json');

let cache = new Map();

const resend = new Resend(RESEND_API_KEY);

// =========================
// 🌐 CORS
// =========================

app.use(
    cors({
        origin: true,
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

        const parsed = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
        cache = new Map(Object.entries(parsed));

        console.log(`✅ Cache chargé : ${cache.size}`);
    } catch (e) {
        console.error('⚠️ Erreur chargement cache:', e.message);
        cache = new Map();
    }
}

function saveCacheToFile() {
    try {
        fs.writeFileSync(
            cacheFilePath,
            JSON.stringify(Object.fromEntries(cache), null, 2)
        );
    } catch (e) {
        console.error('⚠️ Erreur sauvegarde cache:', e.message);
    }
}

function backupOrder(order) {
    try {
        fs.appendFileSync(ordersBackupFilePath, JSON.stringify(order) + '\n');
    } catch (e) {
        console.error('⚠️ Erreur backup commande:', e.message);
    }
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

function cleanName(str = '') {
    return String(str)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\+/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b\d+\s?ml\b/gi, ' ')
        .replace(/\b\d+\s?g\b/gi, ' ')
        .replace(/\bminiature\b/gi, ' ')
        .replace(/\bcoffret\b/gi, ' ')
        .replace(/\bset\b/gi, ' ')
        .replace(/\blait\b/gi, ' ')
        .replace(/\bbody\b/gi, ' ')
        .replace(/\blotion\b/gi, ' ')
        .replace(/\beau de parfum\b/gi, ' ')
        .replace(/\beau de toilette\b/gi, ' ')
        .replace(/\bedp\b/gi, ' ')
        .replace(/\bedt\b/gi, ' ')
        .replace(/\btester\b/gi, ' ')
        .replace(/\btesteur\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getFallbackImage(brand = '', name = '') {
    const query = encodeURIComponent(`${brand} ${cleanName(name)} perfume bottle`);
    return `https://source.unsplash.com/600x600/?${query}`;
}

function isBadImageUrl(url = '') {
    const badDomains = [
        'ipiimages',
        'cityperfume',
        'amazon',
        'ebay',
        'walmart',
        'aliexpress',
        'fragrancex',
        'fragrancenet',
    ];

    const badWords = [
        'sample',
        'tester',
        'testeur',
        'miniature',
        'lotion',
        'body',
        'deodorant',
        'gel',
        'shower',
        'cream',
        'creme',
    ];

    const lower = url.toLowerCase();

    return (
        !lower.startsWith('http') ||
        badDomains.some((d) => lower.includes(d)) ||
        badWords.some((w) => lower.includes(w))
    );
}

function scoreImageUrl(url = '', brand = '', name = '') {
    const lower = url.toLowerCase();
    const brandTokens = cleanName(brand).toLowerCase().split(' ').filter(Boolean);
    const nameTokens = cleanName(name).toLowerCase().split(' ').filter(Boolean);

    let score = 0;

    for (const token of brandTokens) {
        if (lower.includes(token)) score += 5;
    }

    for (const token of nameTokens) {
        if (lower.includes(token)) score += 3;
    }

    if (lower.includes('perfume')) score += 3;
    if (lower.includes('parfum')) score += 3;
    if (lower.includes('bottle')) score += 2;

    if (lower.includes('notino')) score += 4;
    if (lower.includes('sephora')) score += 4;
    if (lower.includes('marionnaud')) score += 4;
    if (lower.includes('nocibe')) score += 4;

    if (isBadImageUrl(url)) score -= 100;

    return score;
}

// =========================
// 📧 EMAIL
// =========================

async function sendOrderEmail(order) {
    const { customer, items, total } = order;

    const subject = `Commande ${APP_NAME} - ${customer.firstName} ${customer.lastName}`;

    const recipients = MAIL_TO_BACKUP ? [MAIL_TO, MAIL_TO_BACKUP] : [MAIL_TO];

    const html = `
    <h2>Nouvelle commande ${APP_NAME}</h2>

    <p><b>Client :</b> ${customer.firstName} ${customer.lastName}</p>
    <p><b>Email :</b> ${customer.email}</p>
    <p><b>Téléphone :</b> ${customer.phone || 'Non renseigné'}</p>

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

app.get('/api/health', (_, res) => {
    res.json({
        status: 'ok',
        app: APP_NAME,
        cacheSize: cache.size,
    });
});

app.get('/api/perfumes/image', async (req, res) => {
    const name = String(req.query.name || '');
    const brand = String(req.query.brand || '');

    if (!name) {
        return res.status(400).json({ error: 'Missing name' });
    }

    const cleanedName = cleanName(name);
    const cleanedBrand = cleanName(brand);
    const key = `${cleanedBrand}_${cleanedName}`.toLowerCase();

    if (cache.has(key)) {
        return res.json({ imageUrl: cache.get(key), cached: true });
    }

    try {
        const query = `${cleanedBrand} ${cleanedName} perfume bottle`;

        console.log('🔎 Recherche image:', query);

        const url = `https://www.bing.com/images/search?q=${encodeURIComponent(
            query
        )}`;

        const { data } = await axios.get(url, {
            timeout: 7000,
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
            },
        });

        const $ = cheerio.load(data);
        const results = [];

        $('.iusc').each((_, el) => {
            const m = $(el).attr('m');

            if (!m) return;

            try {
                const meta = JSON.parse(m);

                if (meta.murl && !isBadImageUrl(meta.murl)) {
                    results.push(forceHttps(meta.murl));
                }
            } catch {
                // ignore JSON parse errors
            }
        });

        const bestImage = results
            .map((imageUrl) => ({
                imageUrl,
                score: scoreImageUrl(imageUrl, cleanedBrand, cleanedName),
            }))
            .sort((a, b) => b.score - a.score)[0]?.imageUrl;

        const image = bestImage || getFallbackImage(cleanedBrand, cleanedName);

        cache.set(key, image);
        saveCacheToFile();

        return res.json({
            imageUrl: image,
            cached: false,
        });
    } catch (e) {
        console.error('❌ Erreur image:', e.message);

        const fallback = getFallbackImage(brand, name);

        cache.set(key, fallback);
        saveCacheToFile();

        return res.json({
            imageUrl: fallback,
            cached: false,
            fallback: true,
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
            console.error('Email failed:', e.message);
            backupOrder(req.body);
        }

        res.json({ success: true });
    } catch (e) {
        console.error('❌ Server error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// =========================
// ▶️ START
// =========================

app.listen(PORT, () => {
    console.log(`🚀 ${APP_NAME} backend running on ${PORT}`);
});