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
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_TO = process.env.MAIL_TO;
const MAIL_TO_BACKUP = process.env.MAIL_TO_BACKUP;
const MAIL_FROM = process.env.MAIL_FROM || 'commandes@negociobom.eu';

// 🔧 Recréer __dirname en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 📁 Fichiers locaux
const cacheFilePath = path.join(__dirname, 'cache.json');
const ordersBackupFilePath = path.join(__dirname, 'orders_backup.json');

// 🧠 Cache mémoire
let cache = new Map();

const resend = new Resend(RESEND_API_KEY);

// =========================
// 🌐 CORS
// =========================

const allowedOrigins = [
    'http://localhost:4200',
    'http://localhost:3000',
    'https://negociobom.eu',
    'https://www.negociobom.eu',
    'https://parfum-front-angular.vercel.app',
    'https://parfum-front-angular-ccki.vercel.app',
    'https://parfum-front-angular-fcd6.vercel.app',
];

app.use(
    cors({
        origin(origin, callback) {
            // ✅ Autorise les requêtes serveur-à-serveur ou certains outils sans header Origin
            if (!origin) {
                return callback(null, true);
            }

            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            console.log('⛔ Origin refusée par CORS :', origin);
            return callback(new Error('Not allowed by CORS'));
        },
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    }),
);


app.use(express.json());

// =========================
// 🛡️ RATE LIMIT
// =========================

const orderLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: {
        error: 'Trop de tentatives. Réessaie plus tard.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// =========================
// 📦 CACHE
// =========================

function loadCacheFromFile() {
    try {
        if (!fs.existsSync(cacheFilePath)) {
            fs.writeFileSync(cacheFilePath, JSON.stringify({}, null, 2), 'utf-8');
            console.log('📁 cache.json créé');
        }

        const fileContent = fs.readFileSync(cacheFilePath, 'utf-8');
        const parsed = JSON.parse(fileContent);

        cache = new Map(Object.entries(parsed));
        console.log(`✅ Cache chargé : ${cache.size} entrée(s)`);
    } catch (error) {
        console.error('❌ Erreur chargement cache :', error);
        cache = new Map();
    }
}

function saveCacheToFile() {
    try {
        const objectToSave = Object.fromEntries(cache);
        fs.writeFileSync(cacheFilePath, JSON.stringify(objectToSave, null, 2));
    } catch (error) {
        console.error('❌ Erreur sauvegarde cache :', error);
    }
}

function backupOrderToFile(order) {
    try {
        fs.appendFileSync(ordersBackupFilePath, JSON.stringify(order) + '\n', 'utf-8');
        console.log('💾 Commande sauvegardée dans orders_backup.json');
    } catch (error) {
        console.error('❌ Impossible de sauvegarder la commande en backup :', error);
    }
}

loadCacheFromFile();

// =========================
// 🧠 UTILS
// =========================

function normalizeText(value) {
    return (value || '')
        .toString()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function cleanPerfumeName(name) {
    return normalizeText(name)
        .replace(/\b\d+\s?ml\b/g, '')
        .replace(/\bedp\b/g, '')
        .replace(/\bedt\b/g, '')
        .replace(/\bparfum\b/g, '')
        .replace(/\beau de parfum\b/g, '')
        .replace(/\beau de toilette\b/g, '')
        .replace(/\btesteur\b/g, '')
        .replace(/\btester\b/g, '')
        .replace(/\bcoffret\b/g, '')
        .replace(/\bminiature\b/g, '')
        .replace(/\bgel\b/g, '')
        .replace(/\blait\b/g, '')
        .replace(/\bdeodorant\b/g, '')
        .replace(/\bdeo\b/g, '')
        .replace(/\bset\b/g, '')
        .replace(/\bbundle\b/g, '')
        .replace(/\+.*$/g, '')
        .replace(/\(.*?\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isBadImageUrl(url) {
    const normalizedUrl = normalizeText(url);

    const blockedKeywords = [
        'testeur',
        'tester',
        'sample',
        'miniature',
        'travel',
        'gel',
        'shower',
        'lait',
        'bodylotion',
        'deodorant',
        'deo',
        'stick',
        'mascara',
        'lipstick',
        'makeup',
        'foundation',
        'blush',
        'palette',
        'set',
        'gift-set',
        'coffret',
        'bundle',
        'lot',
        'soap',
        'cream',
        'aftershave',
        'trousse',
        'mini-',
        'mini_',
    ];

    return blockedKeywords.some((keyword) => normalizedUrl.includes(keyword));
}

function scoreImageUrl(url, parfumName, brand) {
    const normalizedUrl = normalizeText(url);
    const normalizedName = normalizeText(parfumName);
    const normalizedBrand = normalizeText(brand);

    let score = 0;

    if (normalizedBrand && normalizedUrl.includes(normalizedBrand)) {
        score += 4;
    }

    const words = normalizedName.split(/\s+/).filter((word) => word.length > 2);

    for (const word of words) {
        if (normalizedUrl.includes(word)) {
            score += 2;
        }
    }

    if (normalizedUrl.includes('perfume') || normalizedUrl.includes('parfum')) {
        score += 2;
    }

    if (normalizedUrl.includes('edp') || normalizedUrl.includes('edt')) {
        score += 1;
    }

    if (
        normalizedUrl.includes('sephora') ||
        normalizedUrl.includes('notino') ||
        normalizedUrl.includes('marionnaud') ||
        normalizedUrl.includes('nocibe')
    ) {
        score += 3;
    }

    if (isBadImageUrl(url)) {
        score -= 10;
    }

    return score;
}

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatPrice(value) {
    const number = Number(value || 0);
    return `${number.toFixed(2)} €`;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function maskEmail(email) {
    if (!email || !email.includes('@')) return 'non défini';
    const [name, domain] = email.split('@');
    if (name.length <= 2) return `**@${domain}`;
    return `${name.slice(0, 2)}***@${domain}`;
}

function buildOrderHtml(customer, items, total) {
    const rows = items
        .map((item) => {
            const parfum = item.parfum || {};
            const quantity = Number(item.quantity || 0);
            const unitPrice = Number(parfum.price || 0);
            const lineTotal = unitPrice * quantity;

            return `
        <tr>
          <td style="padding:12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(parfum.brand || '')}</td>
          <td style="padding:12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(parfum.name || '')}</td>
          <td style="padding:12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(parfum.gender || '')}</td>
          <td style="padding:12px;border-bottom:1px solid #e5e7eb;text-align:center;">${quantity}</td>
          <td style="padding:12px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatPrice(unitPrice)}</td>
          <td style="padding:12px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatPrice(lineTotal)}</td>
        </tr>
      `;
        })
        .join('');

    return `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;">
      <h2 style="margin-bottom:8px;">Nouvelle commande parfum</h2>
      <p style="margin-top:0;color:#6b7280;">Commande envoyée depuis le site.</p>

      <div style="margin:24px 0;padding:16px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;">
        <h3 style="margin-top:0;">Informations client</h3>
        <p><strong>Prénom :</strong> ${escapeHtml(customer.firstName)}</p>
        <p><strong>Nom :</strong> ${escapeHtml(customer.lastName)}</p>
        <p><strong>Email :</strong> ${escapeHtml(customer.email)}</p>
        <p><strong>Téléphone :</strong> ${escapeHtml(customer.phone)}</p>
        <p><strong>Adresse :</strong><br>${escapeHtml(customer.address).replaceAll('\n', '<br>')}</p>
      </div>

      <div style="margin:24px 0;">
        <h3>Produits commandés</h3>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;">
          <thead style="background:#111827;color:white;">
            <tr>
              <th style="padding:12px;text-align:left;">Marque</th>
              <th style="padding:12px;text-align:left;">Parfum</th>
              <th style="padding:12px;text-align:left;">Genre</th>
              <th style="padding:12px;text-align:center;">Qté</th>
              <th style="padding:12px;text-align:right;">Prix</th>
              <th style="padding:12px;text-align:right;">Sous-total</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>

      <div style="margin-top:24px;padding:16px;border-radius:12px;background:#f3f4f6;">
        <p style="margin:0;font-size:18px;">
          <strong>Total commande : ${formatPrice(total)}</strong>
        </p>
      </div>
    </div>
  `;
}

function buildOrderText(customer, items, total) {
    const lines = items.map((item) => {
        const parfum = item.parfum || {};
        const quantity = Number(item.quantity || 0);
        const unitPrice = Number(parfum.price || 0);
        const lineTotal = unitPrice * quantity;

        return [
            `- ${parfum.brand || ''} ${parfum.name || ''}`,
            `  Genre : ${parfum.gender || ''}`,
            `  Quantité : ${quantity}`,
            `  Prix unitaire : ${formatPrice(unitPrice)}`,
            `  Sous-total : ${formatPrice(lineTotal)}`,
        ].join('\n');
    });

    return `
Nouvelle commande parfum

Informations client
Prénom : ${customer.firstName}
Nom : ${customer.lastName}
Email : ${customer.email}
Téléphone : ${customer.phone}
Adresse : ${customer.address}

Produits
${lines.join('\n\n')}

Total : ${formatPrice(total)}
`.trim();
}

function validateOrderPayload(body) {
    const customer = body?.customer;
    const items = body?.items;
    const total = body?.total;

    if (body?.website) {
        return 'Requête invalide.';
    }

    if (!customer || typeof customer !== 'object') {
        return 'Informations client manquantes.';
    }

    const requiredFields = ['firstName', 'lastName', 'email', 'phone', 'address'];
    for (const field of requiredFields) {
        if (!customer[field] || !String(customer[field]).trim()) {
            return `Champ client manquant : ${field}`;
        }
    }

    if (!isValidEmail(customer.email)) {
        return 'Adresse email invalide.';
    }

    if (!Array.isArray(items) || items.length === 0) {
        return 'Le panier est vide.';
    }

    if (typeof total !== 'number' || Number.isNaN(total)) {
        return 'Total invalide.';
    }

    return null;
}

function forceHttps(url) {
    if (!url) return url;
    return url.replace(/^http:\/\//i, 'https://');
}

// =========================
// 📧 EMAIL / RESEND
// =========================

async function verifyResend() {
    if (!RESEND_API_KEY || !MAIL_TO || !MAIL_FROM) {
        console.error('❌ Configuration Resend incomplète dans le fichier .env');
        console.error('RESEND_API_KEY =', RESEND_API_KEY ? 'définie' : 'non définie');
        console.error('MAIL_FROM =', MAIL_FROM || 'non défini');
        console.error('MAIL_TO =', maskEmail(MAIL_TO));
        console.error('MAIL_TO_BACKUP =', maskEmail(MAIL_TO_BACKUP));
        return;
    }

    console.log('✅ Resend prêt');
    console.log('MAIL_FROM =', MAIL_FROM);
    console.log('MAIL_TO =', maskEmail(MAIL_TO));

    if (MAIL_TO_BACKUP) {
        console.log('MAIL_TO_BACKUP =', maskEmail(MAIL_TO_BACKUP));
    }
}

async function sendOrderEmail({ customer, items, total }) {
    if (!RESEND_API_KEY || !MAIL_TO || !MAIL_FROM) {
        throw new Error('Configuration Resend incomplète dans le fichier .env');
    }

    const subject = `Nouvelle commande - ${customer.firstName} ${customer.lastName}`;
    const recipients = MAIL_TO_BACKUP ? [MAIL_TO, MAIL_TO_BACKUP] : [MAIL_TO];

    console.log('📨 Tentative envoi email via Resend...');
    console.log('De =', MAIL_FROM);
    console.log('Vers =', recipients.map(maskEmail).join(', '));
    console.log('Sujet =', subject);

    const { data, error } = await resend.emails.send({
        from: MAIL_FROM,
        to: recipients,
        replyTo: customer.email,
        subject,
        text: buildOrderText(customer, items, total),
        html: buildOrderHtml(customer, items, total),
    });

    if (error) {
        throw new Error(error.message || "Erreur lors de l'envoi avec Resend");
    }

    console.log('✅ Email envoyé via Resend');
    console.log('Email ID =', data?.id);

    return data;
}

// =========================
// 🚀 ROUTES
// =========================

app.get('/api/perfumes/image', async (req, res) => {
    const { name, brand } = req.query;

    if (!name) {
        return res.status(400).json({ error: 'Missing name' });
    }

    const key = `${brand || ''}_${name}`.toLowerCase();

    if (cache.has(key)) {
        console.log('🟢 Cache HIT :', key);
        return res.json({ imageUrl: forceHttps(cache.get(key)) });
    }

    try {
        const cleanedName = cleanPerfumeName(name);
        const query = `${brand || ''} ${cleanedName} perfume bottle`;

        console.log('🔎 Query :', query);

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
                    const metadata = JSON.parse(m);
                    if (metadata.murl) {
                        results.push(metadata.murl);
                    }
                } catch (_) {
                    // ignore
                }
            }
        });

        let imageUrl = null;

        const scoredResults = results
            .filter((url) => !isBadImageUrl(url))
            .map((url) => ({
                url,
                score: scoreImageUrl(url, name, brand),
            }))
            .sort((a, b) => b.score - a.score);

        if (scoredResults.length > 0) {
            imageUrl = scoredResults[0].url;
        } else if (results.length > 0) {
            imageUrl = results[0];
        }

        if (!imageUrl) {
            imageUrl = `https://picsum.photos/seed/${encodeURIComponent(name)}/600/600`;
        }

        imageUrl = forceHttps(imageUrl);

        cache.set(key, imageUrl);
        saveCacheToFile();

        console.log('🔵 Saved :', key);

        return res.json({ imageUrl });
    } catch (error) {
        console.error('❌ Erreur scraping :', error);

        const fallback = `https://picsum.photos/seed/${encodeURIComponent(name)}/600/600`;

        cache.set(key, fallback);
        saveCacheToFile();

        return res.json({ imageUrl: fallback });
    }
});

app.post('/api/order', orderLimiter, async (req, res) => {
    try {
        const validationError = validateOrderPayload(req.body);

        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const { customer, items, total } = req.body;

        try {
            await sendOrderEmail({ customer, items, total });
        } catch (e) {
            console.error('❌ Email KO MAIS commande reçue :', e);

            backupOrderToFile({
                customer,
                items,
                total,
                date: new Date().toISOString(),
            });
        }

        console.log(
            `📩 Commande traitée pour ${customer.firstName} ${customer.lastName} - total ${formatPrice(total)}`,
        );

        return res.status(200).json({
            success: true,
            message: 'Commande reçue avec succès.',
        });
    } catch (error) {
        console.error('❌ Erreur envoi commande :', error);

        return res.status(500).json({
            error: 'Impossible de traiter la commande.',
            details: error.message,
        });
    }
});

// =========================
// ▶️ START
// =========================

app.listen(PORT, async () => {
    console.log(`🚀 Backend running on port ${PORT}`);
    await verifyResend();
});