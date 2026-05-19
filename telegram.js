import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pn from "awesome-phonenumber";
import { upload } from "./mega.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// ── Remove session folder ─────────────────────────────────────────
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

// ── Generate SURYA-X session ID (same logic as pair.js) ──────────
async function generateSession(credsPath) {
    try {
        const credsData = fs.readFileSync(credsPath, "utf-8");
        const base64Creds = Buffer.from(credsData).toString("base64");
        return `SURYA-X~${base64Creds}`;
    } catch (e) {
        console.error("Session generate error:", e);
        return null;
    }
}

// ── MEGA file ID extractor ────────────────────────────────────────
function getMegaFileId(url) {
    try {
        const match = url.match(/\/file\/([^#]+#[^\/]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

// ── Bot info caption (same style as pair.js) ─────────────────────
const BOT_CAPTION = `
╭━〔 *ꜱᴜʀʏᴀ-x* 〕━··๏
┃★╭──────────────
┃★│ 👑 Owner : *DARKSURYA Official*
┃★│ 🤖 Baileys : *Multi Device*
┃★│ 💻 Type : *NodeJs*
┃★│ 🚀 Platform : *Render*
┃★│ ⚙️ Mode : *Public*
┃★│ 🔣 Prefix : *[ . ]*
┃★│ 🏷️ Version : *8.0.0*
┃★╰──────────────
╰━━━━━━━━━━━━━━┈⊷`;

// ═════════════════════════════════════════════════════════════════
export function initTelegramBot() {
    if (!BOT_TOKEN) {
        console.log("[Telegram] No TELEGRAM_BOT_TOKEN set. Bot disabled.");
        return;
    }

    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log("[Telegram] Bot started successfully.");

    // ── /start ────────────────────────────────────────────────────
    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id,
`╔════════════════════════╗
║       *SURYA-X*         ║
║    Session Linker       ║
╚════════════════════════╝

*Available Commands:*

🔗 /pair \`917797XXXXXX\`
Get session via Pair Code

▦ /qr
Get session via QR Code

❌ /cancel
Stop current session

_Include country code with number_
_Example: /pair 917797099719_`,
            { parse_mode: "Markdown" }
        );
    });

    // ── /help ─────────────────────────────────────────────────────
    bot.onText(/\/help/, (msg) => {
        bot.sendMessage(msg.chat.id,
`*SURYA-X — Help*

🔗 */pair <number>*
Enter number with country code
Example: \`/pair 917797099719\`

▦ */qr*
Generates a QR code image
Scan it with WhatsApp

❌ */cancel*
Stop the current session`,
            { parse_mode: "Markdown" }
        );
    });

    // ── /pair <number> ────────────────────────────────────────────
    bot.onText(/\/pair(?:\s+(\d+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const rawNum = match[1];

        if (!rawNum) {
            return bot.sendMessage(chatId,
`⚠️ *Number missing!*

Example: \`/pair 917797099719\`
_(Include country code)_`,
                { parse_mode: "Markdown" }
            );
        }

        // Validate number
        const phone = pn("+" + rawNum.replace(/[^0-9]/g, ""));
        if (!phone.isValid()) {
            return bot.sendMessage(chatId, "❌ *Invalid phone number.* Include country code.", { parse_mode: "Markdown" });
        }

        const num = phone.getNumber("e164").replace("+", "");
        const dir = "./session_tg_pair_" + num + "_" + Date.now();
        removeFile(dir);

        bot.sendMessage(chatId, "⏳ Connecting to WhatsApp...");

        try {
            const { state, saveCreds } = await useMultiFileAuthState(dir);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" })
                    ),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: false,
            });

            sock.ev.on("creds.update", saveCreds);

            // Request pair code
            if (!sock.authState.creds.registered) {
                await delay(3000);
                try {
                    let code = await sock.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;

                    bot.sendMessage(chatId,
`╔══════════════════════════╗
║      🔑 *PAIR CODE*       ║
╚══════════════════════════╝

*Code:* \`${code}\`

📌 *Steps:*
WhatsApp → ⋮ → *Linked Devices*
→ *Link a Device*
→ *Link with phone number*
→ Enter the code above

_Waiting for you to link..._`,
                        { parse_mode: "Markdown" }
                    );
                } catch (err) {
                    bot.sendMessage(chatId, "❌ *Pair code failed:* " + err.message, { parse_mode: "Markdown" });
                    removeFile(dir);
                    return;
                }
            }

            // Connection update
            sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
                if (connection === "open") {
                    bot.sendMessage(chatId, "✅ *Linked! Generating session...*", { parse_mode: "Markdown" });

                    try {
                        await delay(3000);
                        const credsPath = dir + "/creds.json";
                        const sessionId = await generateSession(credsPath);

                        if (!sessionId) throw new Error("Session generation failed");

                        const jid = jidNormalizedUser(num + "@s.whatsapp.net");

                        // Send session to WhatsApp self
                        await sock.sendMessage(jid, { text: sessionId });

                        // Send bot info image to WhatsApp
                        await sock.sendMessage(jid, {
                            image: { url: "https://files.catbox.moe/jbrn0i.jpg" },
                            caption: BOT_CAPTION,
                            contextInfo: {
                                forwardingScore: 999,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: "120363419670264413@newsletter",
                                    newsletterName: "❀༒★[ꜱᴜʀʏᴀ-x]★༒❀",
                                    serverMessageId: 143
                                }
                            }
                        });

                        // Send session to Telegram
                        bot.sendMessage(chatId,
`✅ *Session Acquired Successfully!*

🆔 *Session ID:*
\`${sessionId}\`

╔════════════════════◇
║  SESSION CONNECTED  ║
║     ✨ SURYA-X 🔷   ║
╚════════════════════╝

╔════════════════════◇
║ ❍ Owner: +917797099719
║ ❍ WaGroup: chat.whatsapp.com/L0oWvAe4eeb6HBYIEPXGbo
║ ❍ Channel: whatsapp.com/channel/0029Vb64JNKJf05UHKREBM1h
║ ❍ Telegram: t.me/DARKSURYA_345
╚════════════════════╝`,
                            { parse_mode: "Markdown" }
                        ).catch(() => {
                            // Session too long — send as file
                            const buf = Buffer.from(sessionId, "utf-8");
                            bot.sendDocument(chatId, buf, {
                                caption: "✅ *Session ready! See attached file.*",
                                parse_mode: "Markdown"
                            }, { filename: "session.txt", contentType: "text/plain" });
                        });

                        await delay(2000);
                        removeFile(dir);

                    } catch (err) {
                        console.error("[pair] open error:", err.message);
                        bot.sendMessage(chatId, "❌ *Error:* " + err.message, { parse_mode: "Markdown" });
                        removeFile(dir);
                    }
                }

                if (connection === "close") {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code !== 401) {
                        bot.sendMessage(chatId, "❌ Connection closed. Please try /pair again.");
                        removeFile(dir);
                    }
                }
            });

        } catch (err) {
            console.error("[Telegram pair] Fatal:", err.message);
            bot.sendMessage(chatId, "❌ *Error:* " + err.message, { parse_mode: "Markdown" });
            removeFile(dir);
        }
    });

    // ── /qr ──────────────────────────────────────────────────────
    bot.onText(/\/qr/, async (msg) => {
        const chatId = msg.chat.id;
        const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        const dir = `./qr_sessions/tg_session_${sessionId}`;

        if (!fs.existsSync("./qr_sessions")) fs.mkdirSync("./qr_sessions", { recursive: true });
        removeFile(dir);

        bot.sendMessage(chatId, "⏳ Generating QR Code...");

        try {
            const { state, saveCreds } = await useMultiFileAuthState(dir);
            const { version } = await fetchLatestBaileysVersion();

            let qrSent = false;

            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" })
                    ),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: false,
            });

            sock.ev.on("creds.update", saveCreds);

            sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr, isNewLogin }) => {

                // Send QR as photo
                if (qr && !qrSent) {
                    qrSent = true;
                    try {
                        const qrBuf = await QRCode.toBuffer(qr, {
                            errorCorrectionLevel: "M",
                            width: 300,
                            margin: 1,
                            color: { dark: "#000000", light: "#FFFFFF" },
                        });
                        bot.sendPhoto(chatId, qrBuf, {
                            caption: `📸 *QR Code Ready!*\n\nWhatsApp → ⋮ → *Linked Devices*\n→ *Link a Device* → *Scan QR Code*\n\n_Expires in ~20 seconds_`,
                            parse_mode: "Markdown"
                        });
                    } catch (e) {
                        bot.sendMessage(chatId, "❌ QR generation failed. Try again.");
                        removeFile(dir);
                    }
                }

                if (connection === "open") {
                    bot.sendMessage(chatId, "✅ *QR Scanned! Generating session...*", { parse_mode: "Markdown" });

                    try {
                        await delay(3000);
                        const credsPath = dir + "/creds.json";

                        // Upload to MEGA (same as qr.js)
                        const megaUrl = await upload(credsPath, `creds_tg_qr_${sessionId}.json`);
                        const megaFileId = getMegaFileId(megaUrl);

                        const userJid = jidNormalizedUser(sock.authState.creds.me?.id || "");

                        if (megaFileId && userJid) {
                            // Send MEGA file ID to WhatsApp self
                            await sock.sendMessage(userJid, { text: megaFileId });

                            // Send bot info to WhatsApp
                            await sock.sendMessage(userJid, {
                                image: { url: "https://files.catbox.moe/jbrn0i.jpg" },
                                caption: BOT_CAPTION,
                            });

                            // Send to Telegram
                            bot.sendMessage(chatId,
`✅ *Session Acquired Successfully!*

🆔 *MEGA Session ID:*
\`${megaFileId}\`

╔════════════════════◇
║  SESSION CONNECTED  ║
║     ✨ SURYA-X 🔷   ║
╚════════════════════╝

╔════════════════════◇
║ ❍ Owner: +917797099719
║ ❍ WaGroup: chat.whatsapp.com/L0oWvAe4eeb6HBYIEPXGbo
║ ❍ Channel: whatsapp.com/channel/0029Vb64JNKJf05UHKREBM1h
║ ❍ Telegram: t.me/DARKSURYA_345
╚════════════════════╝`,
                                { parse_mode: "Markdown" }
                            );
                        } else {
                            bot.sendMessage(chatId, "❌ MEGA upload failed. Try again.");
                        }

                        await delay(2000);
                        removeFile(dir);

                    } catch (err) {
                        console.error("[qr] open error:", err.message);
                        bot.sendMessage(chatId, "❌ *Error:* " + err.message, { parse_mode: "Markdown" });
                        removeFile(dir);
                    }
                }

                if (connection === "close") {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code === 401) {
                        bot.sendMessage(chatId, "❌ Logged out. Please try /qr again.");
                    } else if (!qrSent) {
                        bot.sendMessage(chatId, "❌ Connection closed. Please try /qr again.");
                    }
                    removeFile(dir);
                }
            });

            // Timeout — 30s
            setTimeout(() => {
                if (!qrSent) {
                    bot.sendMessage(chatId, "⏰ *QR timeout.* Please try /qr again.", { parse_mode: "Markdown" });
                    removeFile(dir);
                }
            }, 30000);

        } catch (err) {
            console.error("[Telegram qr] Fatal:", err.message);
            bot.sendMessage(chatId, "❌ *Error:* " + err.message, { parse_mode: "Markdown" });
            removeFile(dir);
        }
    });

    // ── /cancel ───────────────────────────────────────────────────
    bot.onText(/\/cancel/, (msg) => {
        bot.sendMessage(msg.chat.id, "✅ To cancel, simply start a new /pair or /qr command.");
    });

    bot.on("polling_error", (err) => {
        console.error("[Telegram] Polling error:", err.message);
    });

    return bot;
}
