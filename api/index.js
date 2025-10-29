// api/index.js

// --------------------------------------------------
// 1. 导入“插件”和日志模块
// --------------------------------------------------
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@vercel/kv';
import { logToTestAccount } from './logger.js'; // 导入日志模块

// --------------------------------------------------
// 2. 配置 (从 Vercel 环境变量读取)
// --------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : null;
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID ? parseInt(process.env.TEST_ACCOUNT_ID, 10) : null; // 日志接收账号
const LOGGING_MODE = process.env.LOGGING_MODE || "OFF"; // OFF, ALL, REVIEW_ONLY

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error("CRITICAL ERROR: BOT_TOKEN or ADMIN_ID environment variable is not set!");
  // 部署会失败或机器人无法启动
  throw new Error("Missing required environment variables: BOT_TOKEN or ADMIN_ID");
}
if (LOGGING_MODE !== "OFF" && !TEST_ACCOUNT_ID) {
    console.warn("WARN: LOGGING_MODE is enabled but TEST_ACCOUNT_ID is not set. Logging disabled.");
}

// 机器人回复文本
const TEXTS = {
  welcome: "请用‘语音’消息接住以下两个暗号，回答正确✅可🔓子瑜私人活动",
  riddle1: "【暗号1】: 请用语音说出“宝塔震河妖”的上一句。",
  riddle1_success: "✅ 第一个暗号接住了！\n\n【暗号2】: 请用语音说出“今年过节不收礼”的下一句。",
  riddle1_fail_not_voice: "❌ 暗号错误！\n\n必须用【语音】回答【暗号1】哦！请重新发送语音。",
  riddle1_fail_forwarded: "❌ 暗号错误！\n\n请不要转发语音，必须【您自己录制】发送哦！请重新发送语音以回答【暗号1】。",
  riddle2_success: "✅ 全部暗号接住！\n\n你已成功🔓子瑜隐藏活动，待子瑜人工审核确认中……\n\n（请稍等片刻看到第一时间回复）",
  riddle2_fail_not_voice: "❌ 暗号错误！\n\n必须用【语音】回答【暗号2】哦！请重新发送语音。",
  riddle2_fail_forwarded: "❌ 暗号错误！\n\n请不要转发语音，必须【您自己录制】发送哦！请重新发送语音以回答【暗号2】。",
  default: "你好！请点击 /start 开始进行语音暗号验证。",
  admin_reply_success: "✅ 回复已发送。",
  admin_reply_fail: "❌ 发送回复失败。",
  admin_reply_fallback_prompt: (userId, userName = '') =>
    `❌ 自动回复失败！\n可能因对方隐私设置，无法自动获取用户身份。\n\n该用户的 ID 是: \`${userId}\`\n\n请点击下方按钮 **准备手动回复**，它会自动将命令和 ID 填入输入框，您只需在 \`/reply ${userId} \` 后面【接着输入】您的回复内容即可：`,
  admin_invalid_reply_format: "❌ 无效格式。请使用：/reply <用户ID> <消息内容>",
  admin_ban_success: (userId) => `✅ 用户 ${userId} 已被添加到黑名单。`,
  admin_ban_fail: (userId, err) => `❌ 添加用户 ${userId} 到黑名单失败: ${err}`,
  admin_unban_success: (userId) => `✅ 用户 ${userId} 已从黑名单移除。`,
  admin_unban_fail: (userId, err) => `❌ 从黑名单移除用户 ${userId} 失败: ${err}`,
  admin_invalid_ban_format: "❌ 格式错误。请使用：/ban <用户ID>",
  admin_invalid_unban_format: "❌ 格式错误。请使用：/unban <用户ID>",
  admin_user_id_nan: "❌ 用户ID必须是数字。",
  rate_limit_exceeded: "抱歉，您今天发送的消息已达上限 (50条)，请明天再试。",
  forward_to_admin_failed: "⚠️ 将您的信息转发给管理员时出错，请稍后再试或直接联系管理员。",
  banned_user_ignored: "抱歉，您已被限制使用此机器人。",
  // vvvvvvvvvvvvvvvv  请用这个【新的】版本替换掉旧的 vvvvvvvvvvvvvvvv
admin_notification: (userName, userUsername, userId) => {
    let userInfo = userName || '';
    if (userUsername) {
        // 对用户名进行基本的 MarkdownV2 转义 (防止用户名本身包含特殊字符)
        // 这里只转义几个常见的，更完善的需要专门的库或函数
        const escapedUsername = userUsername.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
        userInfo += userInfo ? ` (@${escapedUsername})` : `@${escapedUsername}`;
    }
    // --- 关键修改：转义圆括号，并确保 ID 的反引号也被正确处理 ---
    // ID 本身是数字，通常不需要转义，但外面的括号和反引号需要注意
    userInfo += ` \\(ID: \`${userId}\`\\)`; // 转义 ( 和 )

    // 对 userName 也进行基本的转义
    const escapedUserName = (userName || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
    userInfo = userInfo.replace(userName || '', escapedUserName); // 替换原始名字为转义后的

    return `🔔 用户 ${userInfo} 已通过语音验证，进入人工审核。\n⬇️ 请直接【回复】下方由机器人转发的【用户消息】进行沟通 ⬇️`;
  }
// ^^^^^^^^^^^^^^^^  替换范围到这里结束 ^^^^^^^^^^^^^^^^
};

// --------------------------------------------------
// 3. 初始化机器人和数据库
// --------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);
const kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const BANNED_USERS_KEY = 'banned_users'; // 黑名单 KV Key

// --------------------------------------------------
// 4. 定义状态
// --------------------------------------------------
const STATES = {
  AWAITING_RIDDLE_1: 'awaiting_riddle_1',
  AWAITING_RIDDLE_2: 'awaiting_riddle_2',
  AWAITING_ADMIN_REVIEW: 'awaiting_admin_review',
};

const DAILY_LIMIT = 50; // 每日消息限制

// --------------------------------------------------
// 5. 机器人行为 (Helper 函数)
// --------------------------------------------------
// 封装回复逻辑，统一添加保护和日志
async function replyWithProtectedLog(ctx, text, extra = {}, logType = "BOT_RESPONSE", isInReviewPhase = false) {
    await logToTestAccount(ctx, logType, isInReviewPhase); // 先记录意图回复
    return ctx.reply(text, { ...extra, protect_content: true });
}
// 封装发送消息逻辑
 async function sendMessageProtectedLog(userId, text, extra = {}, logType = "BOT_RESPONSE", isInReviewPhase = false) {
    // 对于发送给用户的消息，无法直接从 ctx 记录，可以构造一个简单的 ctx
    const pseudoCtx = { from: { id: bot.botInfo?.id }, chat: { id: userId } }; // 模拟 bot 发送
    await logToTestAccount(pseudoCtx, logType, isInReviewPhase);
    return bot.telegram.sendMessage(userId, text, { ...extra, protect_content: true });
}
 // 封装发送媒体文件逻辑 (示例: voice)
 async function sendVoiceProtectedLog(userId, fileId, extra = {}, logType = "BOT_RESPONSE", isInReviewPhase = false) {
    const pseudoCtx = { from: { id: bot.botInfo?.id }, chat: { id: userId } };
    await logToTestAccount(pseudoCtx, logType, isInReviewPhase);
    return bot.telegram.sendVoice(userId, fileId, { ...extra, protect_content: true });
}
 // ... 可以为 sendPhoto, sendVideo 等创建类似的封装 ...

// --------------------------------------------------
// 6. 核心处理器
// --------------------------------------------------

// (A) 处理 /start 命令
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    await logToTestAccount(ctx, "USER_COMMAND_START", false); // 记录用户启动

    // --- 黑名单检查 ---
    try {
        const isBanned = await kv.sismember(BANNED_USERS_KEY, userId.toString());
        if (isBanned) { console.log(`Banned user ${userId} tried /start. Ignoring.`); return; }
    } catch (kvErr) { console.error(`KV Error checking ban status for user ${userId} on /start:`, kvErr); }

    // --- 频率限制检查 ---
    const today = new Date().toISOString().slice(0, 10);
    const rateLimitKey = `rate_limit:${userId}:${today}`;
    const dailyMessageCount = await kv.get(rateLimitKey) || 0;
    if (dailyMessageCount >= DAILY_LIMIT) {
        await replyWithProtectedLog(ctx, TEXTS.rate_limit_exceeded, {}, "BOT_RATE_LIMIT", false);
        return;
    }

    // 设置 24 小时自动删除
    try { await ctx.setMessageAutoDeleteTimer(86400); }
    catch (err) { console.error(`User ${userId}: Failed to set auto-delete timer:`, err.message); }

    // 发送流程
    await replyWithProtectedLog(ctx, TEXTS.welcome, {}, "BOT_WELCOME", false);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await replyWithProtectedLog(ctx, TEXTS.riddle1, {}, "BOT_RIDDLE_1", false);

    // 设置状态
    try { await kv.set(`user:${userId}:state`, STATES.AWAITING_RIDDLE_1); }
    catch(kvErr){ console.error(`KV Error setting state for ${userId}:`, kvErr); /* Handle error */ }
    console.log(`User ${userId} started. State set to ${STATES.AWAITING_RIDDLE_1}`);
});

// (B) 处理管理员命令: /reply, /ban, /unban (与之前版本相同，加入了日志)
bot.command('reply', async (ctx) => {
    const adminUserId = ctx.from.id;
    await logToTestAccount(ctx, "ADMIN_COMMAND_REPLY", true); // 管理员操作都算审核阶段
    if (adminUserId !== ADMIN_ID) return;

    const parts = ctx.message.text.split(' ');
    if (parts.length < 3) return ctx.reply(TEXTS.admin_invalid_reply_format);
    const targetUserId = parseInt(parts[1], 10);
    const replyMessageText = parts.slice(2).join(' ');
    if (isNaN(targetUserId) || !replyMessageText) return ctx.reply(TEXTS.admin_invalid_reply_format);

    try {
        await sendMessageProtectedLog(targetUserId, replyMessageText, {}, "ADMIN_REPLY_MANUAL", true);
        await ctx.reply(`${TEXTS.admin_reply_success} (To User ${targetUserId})`);
        console.log(`Admin ${adminUserId} manually replied to User ${targetUserId}`);
    } catch (error) {
        console.error(`Admin ${adminUserId} failed manual reply to ${targetUserId}:`, error);
        await ctx.reply(`${TEXTS.admin_reply_fail} (To User ${targetUserId}). Error: ${error.message}`);
    }
});

bot.command('ban', async (ctx) => {
    const adminUserId = ctx.from.id;
    await logToTestAccount(ctx, "ADMIN_COMMAND_BAN", true);
    if (adminUserId !== ADMIN_ID) return;
    // ... (ban 逻辑与之前相同, 加入 try/catch) ...
    const parts = ctx.message.text.split(' ');
    if (parts.length !== 2) return ctx.reply(TEXTS.admin_invalid_ban_format);
    const targetUserId = parseInt(parts[1], 10);
    if (isNaN(targetUserId)) return ctx.reply(TEXTS.admin_user_id_nan);

    try {
        await kv.sadd(BANNED_USERS_KEY, targetUserId.toString());
        await ctx.reply(TEXTS.admin_ban_success(targetUserId));
        console.log(`Admin ${adminUserId} banned User ${targetUserId}`);
    } catch (kvErr) {
        console.error(`KV Error banning user ${targetUserId}:`, kvErr);
        await ctx.reply(TEXTS.admin_ban_fail(targetUserId, kvErr.message));
    }
});

bot.command('unban', async (ctx) => {
    const adminUserId = ctx.from.id;
    await logToTestAccount(ctx, "ADMIN_COMMAND_UNBAN", true);
    if (adminUserId !== ADMIN_ID) return;
    // ... (unban 逻辑与之前相同, 加入 try/catch) ...
     const parts = ctx.message.text.split(' ');
    if (parts.length !== 2) return ctx.reply(TEXTS.admin_invalid_unban_format);
    const targetUserId = parseInt(parts[1], 10);
    if (isNaN(targetUserId)) return ctx.reply(TEXTS.admin_user_id_nan);

    try {
        await kv.srem(BANNED_USERS_KEY, targetUserId.toString());
        await ctx.reply(TEXTS.admin_unban_success(targetUserId));
        console.log(`Admin ${adminUserId} unbanned User ${targetUserId}`);
    } catch (kvErr) {
        console.error(`KV Error unbanning user ${targetUserId}:`, kvErr);
        await ctx.reply(TEXTS.admin_unban_fail(targetUserId, kvErr.message));
    }
});

// (C) 处理按钮点击 (Ban 用户 和 手动回复回退)
bot.on('callback_query', async (ctx) => {
    const adminUserId = ctx.from.id;
    // 记录按钮点击日志 (无论是否是管理员，但处理只对管理员)
    await logToTestAccount(ctx, "CALLBACK_QUERY", true);

    if (adminUserId !== ADMIN_ID) return await ctx.answerCbQuery("只有管理员可以操作");

    const data = ctx.callbackQuery.data;
    const banPrefix = 'ban_user_';
    const fallbackPrefix = 'reply_fallback_to_';

    try {
        if (data && data.startsWith(banPrefix)) {
            const targetUserId = data.substring(banPrefix.length);
            await kv.sadd(BANNED_USERS_KEY, targetUserId);
            await ctx.answerCbQuery(`用户 ${targetUserId} 已 Ban`);
            await ctx.editMessageReplyMarkup(undefined);
            console.log(`Admin ${adminUserId} banned User ${targetUserId} via button`);
            await ctx.reply(TEXTS.admin_ban_success(targetUserId));

        } else if (data && data.startsWith(fallbackPrefix)) {
            const targetUserId = data.substring(fallbackPrefix.length);
            const commandText = `/reply ${targetUserId} `;
            await ctx.answerCbQuery("请在输入框输入回复");
            await ctx.editMessageReplyMarkup(undefined);
            await ctx.reply(`请在输入框粘贴并补全回复: \`${commandText}\``); // 使用 Markdown 提示
            console.log(`Admin ${adminUserId} initiated fallback reply to User ${targetUserId}`);

        } else {
            await ctx.answerCbQuery("未知操作");
        }
    } catch (error) {
        console.error(`Error processing callback query from admin ${adminUserId}:`, error);
        await ctx.answerCbQuery("处理出错");
        try { await ctx.reply(`处理按钮点击时出错: ${error.message}`);} catch {}
    }
});


// (D) 处理用户的普通消息 (核心逻辑)
bot.on('message', async (ctx) => {
    const userId = ctx.from.id;
    const message = ctx.message;
    const isAdmin = (userId === ADMIN_ID);
    let isInReviewPhase = false; // 标记，用于日志

    // --- 0. 忽略测试账号的消息 ---
    if (userId === TEST_ACCOUNT_ID) {
         console.log("Ignoring message from test account.");
         return;
    }

    // --- 1. 黑名单检查 (非管理员) ---
    if (!isAdmin) {
        try {
            const isBanned = await kv.sismember(BANNED_USERS_KEY, userId.toString());
            if (isBanned) { console.log(`Banned user ${userId} sent message. Ignoring.`); return; }
        } catch (kvErr) { console.error(`KV Error checking ban status for user ${userId}:`, kvErr); }
    }

    // --- 2. 每日频率限制 (非管理员) ---
    if (!isAdmin) {
        const today = new Date().toISOString().slice(0, 10);
        const rateLimitKey = `rate_limit:${userId}:${today}`;
        let dailyMessageCount;
        try {
            dailyMessageCount = await kv.incr(rateLimitKey);
            if (dailyMessageCount === 1) await kv.expire(rateLimitKey, 60 * 60 * 25);
        } catch (kvErr) { console.error(`KV Error rate limit user ${userId}:`, kvErr); dailyMessageCount = 0; }

        if (dailyMessageCount > DAILY_LIMIT) {
            if (dailyMessageCount === DAILY_LIMIT + 1) {
                await replyWithProtectedLog(ctx, TEXTS.rate_limit_exceeded, {}, "BOT_RATE_LIMIT", false);
            }
            console.log(`User ${userId} rate limited. Count: ${dailyMessageCount}`);
            return;
        }
    }

    // --- 记录用户或管理员消息日志 ---
    // (在处理前记录原始消息)
     const currentStateForLog = await kv.get(`user:${userId}:state`); // 获取当前状态以判断日志阶段
     isInReviewPhase = (currentStateForLog === STATES.AWAITING_ADMIN_REVIEW);
     await logToTestAccount(ctx, isAdmin ? "ADMIN_MESSAGE" : "USER_MESSAGE", isInReviewPhase);


    // --- 3. 处理管理员的【直接回复】 ---
    if (isAdmin && message.reply_to_message) {
        const repliedTo = message.reply_to_message;
        if (repliedTo.from?.id === bot.botInfo?.id && repliedTo.forward_from) {
            const originalUser = repliedTo.forward_from;
            const originalUserId = originalUser.id;

            if (originalUserId) {
                try {
                    let sent = false;
                    if (message.text) {
                       await sendMessageProtectedLog(originalUserId, message.text, {}, "ADMIN_REPLY_AUTO", true); sent = true;
                    } else if (message.voice) {
                       await sendVoiceProtectedLog(originalUserId, message.voice.file_id, {}, "ADMIN_REPLY_AUTO", true); sent = true;
                    } // ... 其他类型
                    // else if (message.photo) { ... }

                    if (sent) {
                        await ctx.reply(`${TEXTS.admin_reply_success} (To User ${originalUserId})`);
                        console.log(`Admin ${userId} auto-replied to User ${originalUserId}`);
                    } else {
                        await ctx.reply("❌ 不支持回复此消息类型。");
                    }

                } catch (error) {
                    console.error(`Admin ${userId} failed auto-reply to ${originalUserId}:`, error);
                    await ctx.reply(TEXTS.admin_reply_fallback_prompt(originalUserId, originalUser.first_name),
                        Markup.inlineKeyboard([ Markup.button.callback('✍️ 准备手动回复', `reply_fallback_to_${originalUserId}`) ])
                    );
                }
            } else {
                console.warn(`Admin ${userId} replied, but failed get ID from forward_from.`);
                const notificationTextUserIdMatch = repliedTo.text?.match(/ID: `(\d+)`/); // 尝试从被回复的通知文本中提取ID
                const fallbackUserId = notificationTextUserIdMatch ? notificationTextUserIdMatch[1] : null;
                 if (fallbackUserId) {
                    await ctx.reply(TEXTS.admin_reply_fallback_prompt(fallbackUserId, originalUser?.first_name || ''), // originalUser 可能不存在
                        Markup.inlineKeyboard([ Markup.button.callback('✍️ 准备手动回复', `reply_fallback_to_${fallbackUserId}`) ])
                    );
                 } else {
                    await ctx.reply("❌ 自动回复失败！因对方隐私设置无法获取用户ID。\n请查找之前的通知消息，使用 `/reply <用户ID> <消息内容>` 手动回复。");
                 }
            }
        } else { console.log("Admin replied to non-forwarded message, ignoring."); }
        return; // 管理员回复处理完毕
    }

    // --- 4. 忽略管理员的其他非命令、非回复消息 ---
    if (isAdmin && (!message.text || !message.text.startsWith('/'))) {
        console.log("Ignoring non-command, non-reply message from admin.");
        return;
    }

    // --- 5. 处理用户的正常流程 ---
    const isVoice = !!message.voice;
    // 新增：检查是否转发
    const isForwarded = !!(message.forward_from || message.forward_from_chat || message.forward_date);

    let currentState;
    try { currentState = await kv.get(`user:${userId}:state`); }
    catch (kvErr) {
        console.error(`KV Error getting state for user ${userId}:`, kvErr);
        await replyWithProtectedLog(ctx, "抱歉，暂时无法处理您的请求，请稍后再试。", {}, "BOT_ERROR", false);
        return;
    }

    console.log(`Processing message from User ${userId}. State: ${currentState}, isVoice: ${isVoice}, isForwarded: ${isForwarded}`);
    isInReviewPhase = (currentState === STATES.AWAITING_ADMIN_REVIEW); // 更新日志标记

    switch (currentState) {
        case STATES.AWAITING_RIDDLE_1:
            if (isVoice && !isForwarded) {
                await replyWithProtectedLog(ctx, TEXTS.riddle1_success, {}, "BOT_RIDDLE_1_SUCCESS", false);
                await kv.set(`user:${userId}:riddle1_msg_id`, message.message_id);
                await kv.set(`user:${userId}:state`, STATES.AWAITING_RIDDLE_2);
                console.log(`User ${userId} passed riddle 1. State: ${STATES.AWAITING_RIDDLE_2}. MsgID: ${message.message_id}`);
            } else {
                const failReason = isVoice ? TEXTS.riddle1_fail_forwarded : TEXTS.riddle1_fail_not_voice;
                await replyWithProtectedLog(ctx, failReason, {}, "BOT_RIDDLE_1_FAIL", false);
            }
            break;

        case STATES.AWAITING_RIDDLE_2:
            if (isVoice && !isForwarded) {
                // 进入审核阶段
                isInReviewPhase = true;
                await replyWithProtectedLog(ctx, TEXTS.riddle2_success, {}, "BOT_RIDDLE_2_SUCCESS", isInReviewPhase);

                let riddle1MsgId;
                try { riddle1MsgId = await kv.get(`user:${userId}:riddle1_msg_id`); }
                catch (kvErr) { console.error(`KV Error getting riddle1_msg_id for user ${userId}:`, kvErr); }

                const riddle2MsgId = message.message_id;
                await kv.set(`user:${userId}:state`, STATES.AWAITING_ADMIN_REVIEW);
                console.log(`User ${userId} passed riddle 2. State: ${STATES.AWAITING_ADMIN_REVIEW}. R1 ID: ${riddle1MsgId}, R2 ID: ${riddle2MsgId}`);

                // --- 转发给管理员 ---
                const userName = ctx.from.first_name || '';
                const userUsername = ctx.from.username || '';
                let adminNotificationCtx; // 用于记录发给管理员的通知日志

                try {
                    // 发送带 Ban 按钮的通知
                    adminNotificationCtx = await bot.telegram.sendMessage(ADMIN_ID,
                        TEXTS.admin_notification(userName, userUsername, userId), {
                            parse_mode: 'MarkdownV2',
                            ...Markup.inlineKeyboard([ Markup.button.callback('🚫 Ban 用户', `ban_user_${userId}`) ])
                        }
                    );
                    await logToTestAccount({ // 手动构造 ctx 记录日志
                        from: { id: bot.botInfo?.id }, // 机器人发的
                        message: adminNotificationCtx // 消息体
                     }, "BOT_ADMIN_NOTIFICATION", isInReviewPhase);


                    // 尝试转发语音
                    let forwardedMsg1Ctx, forwardedMsg2Ctx;
                    if (riddle1MsgId) {
                        forwardedMsg1Ctx = await bot.telegram.forwardMessage(ADMIN_ID, userId, riddle1MsgId);
                        await logToTestAccount({ from: {id: userId}, message: forwardedMsg1Ctx }, "FORWARD_VOICE_1_TO_ADMIN", isInReviewPhase);
                    } else { await bot.telegram.sendMessage(ADMIN_ID, `(未能获取用户 ${userId} 的第一段暗号语音)`); }

                    forwardedMsg2Ctx = await bot.telegram.forwardMessage(ADMIN_ID, userId, riddle2MsgId);
                    await logToTestAccount({ from: {id: userId}, message: forwardedMsg2Ctx }, "FORWARD_VOICE_2_TO_ADMIN", isInReviewPhase);

                } catch (error) {
                    console.error(`Failed forward for User ${userId} to admin:`, error);
                    try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ 转发用户 ${userId} 语音出错: ${error.message}`); } catch {}
                    await replyWithProtectedLog(ctx, TEXTS.forward_to_admin_failed, {}, "BOT_ERROR", isInReviewPhase);
                }
                // 清理临时消息 ID
                if (riddle1MsgId) { try { await kv.del(`user:${userId}:riddle1_msg_id`); } catch {} }

            } else {
                const failReason = isVoice ? TEXTS.riddle2_fail_forwarded : TEXTS.riddle2_fail_not_voice;
                await replyWithProtectedLog(ctx, failReason, {}, "BOT_RIDDLE_2_FAIL", false);
            }
            break;

        case STATES.AWAITING_ADMIN_REVIEW:
            // 用户通过验证后，不再自动处理他们的消息，等待管理员回复
            console.log(`Ignoring message from User ${userId} in state ${currentState} (awaiting admin).`);
            // 可选: await replyWithProtectedLog(ctx, "管理员已知晓，请耐心等待回复。", {}, "BOT_WAITING_INFO", true);
            break;

        default:
            await replyWithProtectedLog(ctx, TEXTS.default, {}, "BOT_DEFAULT", false);
    }
});

// --------------------------------------------------
// 7. Vercel 部署设置
// --------------------------------------------------
export default async (request, response) => {
    if (!BOT_TOKEN || !ADMIN_ID) {
         console.error("CRITICAL: Bot cannot start due to missing environment variables.");
         return response.status(500).send("Internal Server Error: Bot configuration missing.");
    }
    if (request.method === "POST") {
        try {
            await bot.handleUpdate(request.body);
        } catch (err) {
            console.error("Error handling update:", err);
        }
    }
    response.status(200).send("OK");
};

// // 本地开发用轮询 (可选)
// if (process.env.NODE_ENV !== 'production') {
//   if(BOT_TOKEN && ADMIN_ID){
//      console.log("Starting bot in polling mode for local development...");
//      bot.launch();
//      process.once('SIGINT', () => bot.stop('SIGINT'));
//      process.once('SIGTERM', () => bot.stop('SIGTERM'));
//   } else {
//      console.error("Cannot start polling: BOT_TOKEN or ADMIN_ID missing.");
//   }
// }