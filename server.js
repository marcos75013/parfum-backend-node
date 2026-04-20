import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import dns from 'node:dns';

dotenv.config();

// ✅ Important : préfère IPv4 pour éviter les soucis IPv6 / EHOSTUNREACH
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(cors());
app.use(express.json());

// =========================
// ⚙️ CONFIG
// =========================

const PORT = Number(process.env.PORT || 3000);

// 🔧 Recréer __dirname en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 📁 Fichier cache
const cacheFilePath = path.join(__dirname, 'cache.json');

// 🧠 Cache mémoire
let cache = new Map();

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

    if (!customer || typeof customer !== 'object') {
        return 'Informations client manquantes.';
    }

    const requiredFields = ['firstName', 'lastName', 'email', 'phone', 'address'];
    for (const field of requiredFields) {
        if (!customer[field] || !String(customer[field]).trim()) {
            return `Champ client manquant : ${field}`;
        }
    }

    if (!Array.isArray(items) || items.length === 0) {
        return 'Le panier est vide.';
    }

    if (typeof total !== 'number') {
        return 'Total invalide.';
    }

    return null;
}

// =========================
// 📧 EMAIL / SMTP
// =========================

const MAIL_HOST = process.env.MAIL_HOST || 'smtp.gmail.com';
const MAIL_PORT = Number(process.env.MAIL_PORT || 465);
const MAIL_SECURE =
    process.env.MAIL_SECURE !== undefined
        ? String(process.env.MAIL_SECURE).toLowerCase() === 'true'
        : MAIL_PORT === 465;

const MAIL_USER = process.env.MAIL_USER;
const MAIL_PASS = process.env.MAIL_PASS;
const MAIL_TO = process.env.MAIL_TO || process.env.MAIL_USER;

function maskEmail(email) {
    if (!email || !email.includes('@')) return 'non défini';
    const [name, domain] = email.split('@');
    if (name.length <= 2) return `**@${domain}`;
    return `${name.slice(0, 2)}***@${domain}`;
}

const transporter = nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: MAIL_SECURE,
    auth: {
        user: MAIL_USER,
        pass: MAIL_PASS,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    logger: true,
    debug: true,
});

async function verifySmtp() {
    if (!MAIL_HOST || !MAIL_USER || !MAIL_PASS || !MAIL_TO) {
        console.error('❌ Configuration email incomplète dans le fichier .env');
        console.error('MAIL_HOST =', MAIL_HOST || 'non défini');
        console.error('MAIL_PORT =', MAIL_PORT || 'non défini');
        console.error('MAIL_SECURE =', MAIL_SECURE);
        console.error('MAIL_USER =', maskEmail(MAIL_USER));
        console.error('MAIL_PASS =', MAIL_PASS ? 'défini' : 'non défini');
        console.error('MAIL_TO =', maskEmail(MAIL_TO));
        return;
    }

    console.log('📧 Vérification SMTP...');
    console.log('MAIL_HOST =', MAIL_HOST);
    console.log('MAIL_PORT =', MAIL_PORT);
    console.log('MAIL_SECURE =', MAIL_SECURE);
    console.log('MAIL_USER =', maskEmail(MAIL_USER));
    console.log('MAIL_TO =', maskEmail(MAIL_TO));

    try {
        await transporter.verify();
        console.log('✅ SMTP prêt : connexion email OK');
    } catch (error) {
        console.error('❌ SMTP erreur de configuration :', error);
    }
}

async function sendOrderEmail({ customer, items, total }) {
    if (!MAIL_HOST || !MAIL_USER || !MAIL_PASS || !MAIL_TO) {
        throw new Error('Configuration email incomplète dans le fichier .env');
    }

    const subject = `Nouvelle commande - ${customer.firstName} ${customer.lastName}`;

    const mailOptions = {
        from: `"Parfum App" <${MAIL_USER}>`,
        to: MAIL_TO,
        replyTo: customer.email,
        subject,
        text: buildOrderText(customer, items, total),
        html: buildOrderHtml(customer, items, total),
    };

    console.log('📨 Tentative envoi email...');
    console.log('De =', maskEmail(MAIL_USER));
    console.log('Vers =', maskEmail(MAIL_TO));
    console.log('Sujet =', subject);

    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email envoyé');
    console.log('MessageId =', info.messageId);

    return info;
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
        return res.json({ imageUrl: cache.get(key) });
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

app.post('/api/order', async (req, res) => {
    try {
        const validationError = validateOrderPayload(req.body);

        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const { customer, items, total } = req.body;

        await sendOrderEmail({ customer, items, total });

        console.log(
            `📩 Commande envoyée par email pour ${customer.firstName} ${customer.lastName} - total ${formatPrice(total)}`
        );

        return res.status(200).json({
            success: true,
            message: 'Commande envoyée avec succès.',
        });
    } catch (error) {
        console.error('❌ Erreur envoi commande :', error);

        return res.status(500).json({
            error: "Impossible d'envoyer la commande.",
            details: error.message,
        });
    }
});

// =========================
// ▶️ START
// =========================

app.listen(PORT, async () => {
    console.log(`🚀 Backend running on http://localhost:${PORT}`);
    await verifySmtp();
});
