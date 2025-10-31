// api/index.js (最终版，包含审核通过逻辑)

// --------------------------------------------------
// 1. 导入“插件”和日志模块
// --------------------------------------------------
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@vercel/kv';
// 从 logger.js 导入日志函数和常量
import { logToTestAccount, LOGGING_MODE, REVIEW_ONLY, REVIEW_STATES } from './logger.js';

// --------------------------------------------------
// 2. 配置 (从 Vercel 环境变量读取)
// --------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : null;
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID ? parseInt(process.env.TEST_ACCOUNT_ID, 10) : null;

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error("CRITICAL ERROR: BOT_TOKEN or ADMIN_ID environment variable is not set!");
  throw new Error("Missing required environment variables: BOT_TOKEN or ADMIN_ID");
}
if (LOGGING_MODE !== "OFF" && !TEST_ACCOUNT_ID) {
    console.warn("WARN: LOGGING_MODE is enabled but TEST_ACCOUNT_ID is not set. Logging disabled.");
}

// --------------------------------------------------
// 3. 机器人回复文本 (TEXTS) 对象
// --------------------------------------------------
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
  admin_approve_success: (userId) => `✅ 用户 ${userId} 已标记为【审核通过】。`, // <-- 新增
  user_approved_notification: "恭喜！您的人工审核已通过！您现在可以通过此机器人与管理员联系。", // <-- 新增
  rate_limit_exceeded: "抱歉，您今天发送的消息已达上限 (50条)，请明天再试。",
  forward_to_admin_failed: "⚠️ 将您的信息转发给管理员时出错，请稍后再试或直接联系管理员。",
  admin_notification: (userName, userUsername, userId) => {
      const escapeMarkdownV2 = (text) => {
          if (!text) return '';
          return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
      };
      const escapedUserName = escapeMarkdownV2(userName || '');
      const escapedUserUsername = userUsername ? `@${escapeMarkdownV2(userUsername)}` : '';
      let userInfo = escapedUserName || '';
      if (escapedUserUsername) {
          userInfo += userInfo ? ` \\(${escapedUserUsername}\\)` : escapedUserUsername;
      }
      userInfo += ` \\(ID: \`${userId}\`\\)`;
      return `🔔 用户 ${userInfo} 已通过语音验证，进入人工审核。\n⬇️ 请直接【回复】下方由机器人转发的【用户消息】进行沟通 ⬇️`;
  }
};

// --------------------------------------------------
// 4. 初始化机器人和数据库
// --------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);
const kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});
const BANNED_USERS_KEY = 'banned_users';
const STATES = REVIEW_STATES; // 使用从 logger 导入的状态
const DAILY_LIMIT = 50;

// --------------------------------------------------
// 5. 封装回复函数 (统一添加保护和日志)
// --------------------------------------------------
async function replyWithProtectedLog(ctx, text, extra = {}, logType = "BOT_RESPONSE", isInReviewPhase = false) {
    const responseCtx = await ctx.reply(text, { ...extra, protect_content: true });
    const logCtx = { ...ctx, message: responseCtx, from: { id: bot.botInfo?.id } };
    await logToTestAccount(logCtx, logType, isInReviewPhase);
    return responseCtx;
}
async function sendMessageProtectedLog(userId, text, extra = {}, logType = "ADMIN_REPLY", isInReviewPhase = false) {
    const responseCtx = await bot.telegram.sendMessage(userId, text, { ...extra, protect_content: true });
    const logCtx = { from: { id: ADMIN_ID }, message: responseCtx, chat: { id: userId } };
    await logToTestAccount(logCtx, logType, isInReviewPhase);
    return responseCtx;
}
 async function sendVoiceProtectedLog(userId, fileId, extra = {}, logType = "ADMIN_REPLY", isInReviewPhase = false) {
    const responseCtx = await bot.telegram.sendVoice(userId, fileId, { ...extra, protect_content: true });
    const logCtx = { from: { id: ADMIN_ID }, message: responseCtx, chat: { id: userId } };
    await logToTestAccount(logCtx, logType, isInReviewPhase);
    return responseCtx;
}
// ... (其他 sendX 函数) ...

// --------------------------------------------------
// 6. 核心处理器
// --------------------------------------------------

// (A) 处理 /start 命令
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    await logToTestAccount(ctx, "USER_CMD_START", false);

    if (userId === ADMIN_ID || userId === TEST_ACCOUNT_ID) {
        await ctx.reply("管理员或测试账号，跳过 /start 流程。");
        return;
    }

    try {
        const isBanned = await kv.sismember(BANNED_USERS_KEY, userId.toString());
        if (isBanned) { console.log(`Banned user ${userId} tried /start. Ignoring.`); return; }
    } catch (kvErr) { console.error(`KV Error checking ban status for user ${userId} on /start:`, kvErr); }

    const today = new Date().toISOString().slice(0, 10);
    const rateLimitKey = `rate_limit:${userId}:${today}`;
    const dailyMessageCount = await kv.get(rateLimitKey) || 0;
    if (dailyMessageCount >= DAILY_LIMIT) {
        await replyWithProtectedLog(ctx, TEXTS.rate_limit_exceeded, {}, "BOT_RATE_LIMIT", false);
        return;
    }

    try { await ctx.setMessageAutoDeleteTimer(86400); }
    catch (err) { console.error(`User ${userId}: Failed to set auto-delete timer:`, err.message); }

    await replyWithProtectedLog(ctx, TEXTS.welcome, {}, "BOT_WELCOME", false);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await replyWithProtectedLog(ctx, TEXTS.riddle1, {}, "BOT_RIDDLE_1", false);

    try { await kv.set(`user:${userId}:state`, STATES.AWAITING_RIDDLE_1); }
    catch(kvErr){ console.error(`KV Error setting state for ${userId}:`, kvErr); }
    console.log(`User ${userId} started. State set to ${STATES.AWAITING_RIDDLE_1}`);
});

// (B) 处理管理员命令: /reply, /ban, /unban (不变)
bot.command('reply', async (ctx) => {
    await logToTestAccount(ctx, "ADMIN_CMD_REPLY", true);
    if (ctx.from.id !== ADMIN_ID) return;
    // ... (代码与上一版相同) ...
    const parts = ctx.message.text.split(' ');
    if (parts.length < 3) return ctx.reply(TEXTS.admin_invalid_reply_format);
    const targetUserId = parseInt(parts[1], 10);
    const replyMessageText = parts.slice(2).join(' ');
    if (isNaN(targetUserId) || !replyMessageText) return ctx.reply(TEXTS.admin_invalid_reply_format);
    try {
        await sendMessageProtectedLog(targetUserId, replyMessageText, {}, "ADMIN_REPLY_MANUAL", true);
        await ctx.reply(`${TEXTS.admin_reply_success} (To User ${targetUserId})`);
    } catch (error) {
        await ctx.reply(`${TEXTS.admin_reply_fail} (To User ${targetUserId}). Error: ${error.message}`);
    }
});

bot.command('ban', async (ctx) => {
    await logToTestAccount(ctx, "ADMIN_CMD_BAN", true);
    if (ctx.from.id !== ADMIN_ID) return;
    // ... (代码与上一版相同) ...
    const parts = ctx.message.text.split(' ');
    if (parts.length !== 2) return ctx.reply(TEXTS.admin_invalid_ban_format);
    const targetUserId = parseInt(parts[1], 10);
    if (isNaN(targetUserId)) return ctx.reply(TEXTS.admin_user_id_nan);
    try {
        await kv.sadd(BANNED_USERS_KEY, targetUserId.toString());
        await ctx.reply(TEXTS.admin_ban_success(targetUserId));
    } catch (kvErr) {
        await ctx.reply(TEXTS.admin_ban_fail(targetUserId, kvErr.message));
    }
});

bot.command('unban', async (ctx) => {
    await logToTestAccount(ctx, "ADMIN_CMD_UNBAN", true);
    if (ctx.from.id !== ADMIN_ID) return;
    // ... (代码与上一版相同) ...
    const parts = ctx.message.text.split(' ');
    if (parts.length !== 2) return ctx.reply(TEXTS.admin_invalid_unban_format);
    const targetUserId = parseInt(parts[1], 10);
    if (isNaN(targetUserId)) return ctx.reply(TEXTS.admin_user_id_nan);
    try {
        await kv.srem(BANNED_USERS_KEY, targetUserId.toString());
        await ctx.reply(TEXTS.admin_unban_success(targetUserId));
    } catch (kvErr) {
        await ctx.reply(TEXTS.admin_unban_fail(targetUserId, kvErr.message));
    }
});

// (C) 处理按钮点击 (【!! 已修改 !!】 新增 approve_user 逻辑)
bot.on('callback_query', async (ctx) => {
    const adminUserId = ctx.from.id;
    await logToTestAccount(ctx, "CALLBACK_QUERY", true);

    if (adminUserId !== ADMIN_ID) return await ctx.answerCbQuery("只有管理员可以操作");

    const data = ctx.callbackQuery.data;
    const banPrefix = 'ban_user_';
    const fallbackPrefix = 'reply_fallback_to_';
    const approvePrefix = 'approve_user_'; // <-- 【!! 新增 !!】

    try {
        if (data && data.startsWith(banPrefix)) {
            const targetUserId = data.substring(banPrefix.length);
            await kv.sadd(BANNED_USERS_KEY, targetUserId);
            await ctx.answerCbQuery(`用户 ${targetUserId} 已 Ban`);
            // 尝试移除按钮 (如果消息未被删除)
            try { await ctx.editMessageReplyMarkup(undefined); } catch {}
            console.log(`Admin ${adminUserId} banned User ${targetUserId} via button`);
            await ctx.reply(TEXTS.admin_ban_success(targetUserId));

        } else if (data && data.startsWith(fallbackPrefix)) {
            const targetUserId = data.substring(fallbackPrefix.length);
            const commandText = `/reply ${targetUserId} `;
            await ctx.answerCbQuery("请在输入框输入回复");
            try { await ctx.editMessageReplyMarkup(undefined); } catch {}
            await ctx.reply(`请在输入框粘贴并补全回复: \`${commandText}\``, { parse_mode: 'MarkdownV2' });
            console.log(`Admin ${adminUserId} initiated fallback reply to User ${targetUserId}`);

        } else if (data && data.startsWith(approvePrefix)) { // <-- 【!! 新增 !!】
            const targetUserId = data.substring(approvePrefix.length);
            // 1. 更新 KV 状态
            await kv.set(`user:${targetUserId}:state`, STATES.COMPLETED);
            await ctx.answerCbQuery(`用户 ${targetUserId} 已审核通过`);
            // 2. 移除按钮
            try { await ctx.editMessageReplyMarkup(undefined); } catch {}
            // 3. 回复管理员
            await ctx.reply(TEXTS.admin_approve_success(targetUserId));
            console.log(`Admin ${adminUserId} approved User ${targetUserId}`);
            // 4. 通知用户
            await sendMessageProtectedLog(targetUserId, TEXTS.user_approved_notification, {}, "BOT_APPROVED", true);
        
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
    let isInReviewPhase = false;

    // --- 0. 忽略测试账号的消息 ---
    if (userId === TEST_ACCOUNT_ID) {
         console.log("Ignoring message from test account.");
         return;
    }
    
    // --- 1. 黑名单检查 (非管理员) ---
    if (!isAdmin) {
        try {
            const isBanned = await kv.sismember(BANNED_USERS_KEY, userId.toString());
            if (isBanned) { 
                console.log(`Banned user ${userId} sent message. Ignoring.`); 
                await logToTestAccount(ctx, "USER_BANNED_IGNORED", false);
                return; 
            }
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
            } else {
                 await logToTestAccount(ctx, "USER_RATE_LIMITED", false);
            }
            console.log(`User ${userId} rate limited. Count: ${dailyMessageCount}`);
            return;
        }
    }

    // --- 获取当前状态（用于日志） ---
     let currentStateForLog;
     try { currentStateForLog = await kv.get(`user:${userId}:state`); } catch {}
     isInReviewPhase = (currentStateForLog === STATES.AWAITING_ADMIN_REVIEW || currentStateForLog === STATES.COMPLETED);
     await logToTestAccount(ctx, isAdmin ? "ADMIN_MESSAGE" : "USER_MESSAGE", isInReviewPhase);


    // --- 3. 处理管理员的【回复】 (不变) ---
    if (isAdmin && message.reply_to_message) {
        // ... (与上一版完全相同的回复逻辑) ...
        const repliedTo = message.reply_to_message;
        let targetUserId = null;
        let userNameForFallback = '该用户';
        if (repliedTo.from?.id === bot.botInfo?.id) {
            if (repliedTo.text && repliedTo.text.startsWith('🔔 用户')) {
                console.log("Admin replied to notification text.");
                const match = repliedTo.text.match(/\(ID: (\d+)\)/); // <-- 使用我们修复后的 Regex
                if (match && match[1]) {
                    targetUserId = parseInt(match[1], 10);
                } else {
                    console.error("Admin replied to notification, but couldn't parse User ID!");
                    await ctx.reply("❌ 回复失败，无法从通知消息中解析到用户ID。");
                    return;
                }
            }
            else if (repliedTo.forward_date) {
                console.log("Admin replied to forwarded message.");
                if (repliedTo.forward_from) {
                    targetUserId = repliedTo.forward_from.id;
                    userNameForFallback = repliedTo.forward_from.first_name || '该用户';
                }
            }
        }
        if (targetUserId) {
            try {
                let sent = false;
                if (message.text) {
                   await sendMessageProtectedLog(targetUserId, message.text, {}, "ADMIN_REPLY_AUTO", true); sent = true;
                } else if (message.voice) {
                   await sendVoiceProtectedLog(targetUserId, message.voice.file_id, {}, "ADMIN_REPLY_AUTO", true); sent = true;
                } else if (message.photo) {
                   const photoFileId = message.photo[message.photo.length - 1].file_id;
                   await bot.telegram.sendPhoto(targetUserId, photoFileId, { protect_content: true });
                   await logToTestAccount(ctx, "ADMIN_REPLY_AUTO_PHOTO", true);
                   sent = true;
                } 
                else {
                   await ctx.reply("❌ 不支持回复此消息类型。");
                }
                if (sent) {
                    await ctx.reply(`${TEXTS.admin_reply_success} (To User ${targetUserId})`);
                    console.log(`Admin ${userId} auto-replied to User ${targetUserId}`);
                }
            } catch (error) {
                console.error(`Admin ${userId} failed auto-reply to ${targetUserId}:`, error);
                await ctx.reply(`${TEXTS.admin_reply_fail} (To User ${targetUserId}). Error: ${error.message}`);
            }
        } 
        else if (repliedTo.forward_date) {
            console.warn(`Admin ${userId} replied, but failed get ID from forward_from (privacy).`);
            await ctx.reply("❌ 自动回复失败！\n因对方开启了隐私设置，无法从【这条转发的消息】中获取用户ID。\n\n**请【回复】那条【文本通知】消息** (包含ID:...)，或者使用 `/reply <用户ID> <消息>` 手动回复。", { parse_mode: 'Markdown' });
        }
        else {
            console.log("Admin replied to an irrelevant message, ignoring.");
        }
        return; // 管理员回复处理完毕
    }
    // --- 【回复处理结束】---


    // --- 4. 忽略管理员的其他非命令、非回复消息 ---
    if (isAdmin && (!message.text || !message.text.startsWith('/'))) {
        console.log("Ignoring non-command, non-reply message from admin.");
        return;
    }

    // --- 5. 处理用户的正常流程 ---
    const isVoice = !!message.voice;
    const isForwarded = !!(message.forward_from || message.forward_from_chat || message.forward_date);

    let currentState;
    try { currentState = await kv.get(`user:${userId}:state`); }
    catch (kvErr) {
        console.error(`KV Error getting state for user ${userId}:`, kvErr);
        await replyWithProtectedLog(ctx, "抱歉，暂时无法处理您的请求，请稍后再试。", {}, "BOT_ERROR", false);
        return;
    }

    console.log(`Processing message from User ${userId}. State: ${currentState}, isVoice: ${isVoice}, isForwarded: ${isForwarded}`);
    isInReviewPhase = (currentState === STATES.AWAITING_ADMIN_REVIEW || currentState === STATES.COMPLETED);

    switch (currentState) {
        case STATES.AWAITING_RIDDLE_1:
            if (isVoice && !isForwarded) {
                await replyWithProtectedLog(ctx, TEXTS.riddle1_success, {}, "BOT_RIDDLE_1_SUCCESS", false);
                try {
                    await kv.set(`user:${userId}:riddle1_msg_id`, message.message_id);
                    await kv.set(`user:${userId}:state`, STATES.AWAITING_RIDDLE_2);
                } catch (kvErr) { console.error(`KV Error setting state/msgId for ${userId}:`, kvErr); }
                console.log(`User ${userId} passed riddle 1. State: ${STATES.AWAITING_RIDDLE_2}. MsgID: ${message.message_id}`);
            } else {
                const failReason = isVoice ? TEXTS.riddle1_fail_forwarded : TEXTS.riddle1_fail_not_voice;
                await replyWithProtectedLog(ctx, failReason, {}, "BOT_RIDDLE_1_FAIL", false);
            }
            break;

        case STATES.AWAITING_RIDDLE_2:
            if (isVoice && !isForwarded) {
                isInReviewPhase = true;
                await replyWithProtectedLog(ctx, TEXTS.riddle2_success, {}, "BOT_RIDDLE_2_SUCCESS", isInReviewPhase);

                let riddle1MsgId;
                try { riddle1MsgId = await kv.get(`user:${userId}:riddle1_msg_id`); }
                catch (kvErr) { console.error(`KV Error getting riddle1_msg_id for user ${userId}:`, kvErr); }

                const riddle2MsgId = message.message_id;
                try { await kv.set(`user:${userId}:state`, STATES.AWAITING_ADMIN_REVIEW); } catch (kvErr) {}
                console.log(`User ${userId} passed riddle 2. State: ${STATES.AWAITING_ADMIN_REVIEW}. R1 ID: ${riddle1MsgId}, R2 ID: ${riddle2MsgId}`);

                const userName = ctx.from.first_name || '';
                const userUsername = ctx.from.username || '';
                let adminNotificationCtx;

                try {
                    // --- 【!! 已修改 !!】 ---
                    // 发送带 Ban 按钮 和 审核通过 按钮的通知
                    adminNotificationCtx = await bot.telegram.sendMessage(ADMIN_ID,
                        TEXTS.admin_notification(userName, userUsername, userId), {
                            parse_mode: 'MarkdownV2',
                            ...Markup.inlineKeyboard([
                                // 一行放两个按钮
                                Markup.button.callback('🚫 Ban 用户', `ban_user_${userId}`),
                                Markup.button.callback('✅ 审核通过', `approve_user_${userId}`)
                            ])
                        }
                    );
                    // --- 【!! 修改结束 !!】 ---
                    
                    await logToTestAccount({ from: {id: bot.botInfo?.id}, message: adminNotificationCtx }, "BOT_ADMIN_NOTIFICATION", isInReviewPhase);

                    // 转发语音
                    let forwardedMsg1Ctx, forwardedMsg2Ctx;
                    if (riddle1MsgId) {
                        forwardedMsg1Ctx = await bot.telegram.forwardMessage(ADMIN_ID, userId, riddle1MsgId);
                        await logToTestAccount({ from: {id: userId}, message: forwardedMsg1Ctx, chat: {id: userId} }, "FORWARD_VOICE_1_TO_ADMIN", isInReviewPhase);
                    } else { 
                        const failMsgCtx = await bot.telegram.sendMessage(ADMIN_ID, `(未能获取用户 ${userId} 的第一段暗号语音)`); 
                        await logToTestAccount({ from: {id: bot.botInfo?.id}, message: failMsgCtx }, "BOT_ADMIN_ERROR", isInReviewPhase);
                    }

                    forwardedMsg2Ctx = await bot.telegram.forwardMessage(ADMIN_ID, userId, riddle2MsgId);
                    await logToTestAccount({ from: {id: userId}, message: forwardedMsg2Ctx, chat: {id: userId} }, "FORWARD_VOICE_2_TO_ADMIN", isInReviewPhase);

                } catch (error) {
                    console.error(`Failed forward for User ${userId} to admin:`, error);
                    try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ 转发用户 ${userId} 语音出错: ${error.message}`); } catch {}
                    await replyWithProtectedLog(ctx, TEXTS.forward_to_admin_failed, {}, "BOT_ERROR", isInReviewPhase);
                }
                if (riddle1MsgId) { try { await kv.del(`user:${userId}:riddle1_msg_id`); } catch {} }

            } else {
                const failReason = isVoice ? TEXTS.riddle2_fail_forwarded : TEXTS.riddle2_fail_not_voice;
                await replyWithProtectedLog(ctx, failReason, {}, "BOT_RIDDLE_2_FAIL", false);
            }
            break;

        // --- 【!! 已修改 !!】 ---
        case STATES.AWAITING_ADMIN_REVIEW:
        case STATES.COMPLETED: // 两个状态执行相同逻辑
            // 用户通过审核后，继续转发他们的消息给管理员
            console.log(`User ${userId} (in review/completed) sent new message. Forwarding to admin.`);
            try {
                // 1. (可选) 发送一个简单的文本提示
                await bot.telegram.sendMessage(ADMIN_ID, `(用户 ${userId} 发来一条新消息，供您参考):`);
                
                // 2. 转发用户的这条新消息
                const forwardedMsgCtx = await bot.telegram.forwardMessage(ADMIN_ID, userId, message.message_id);
                
                // 3. 记录日志
                await logToTestAccount({ from: {id: userId}, message: forwardedMsgCtx, chat: {id: userId} }, "FORWARD_FOLLOWUP_TO_ADMIN", true);

            } catch (error) {
                console.error(`Failed to forward follow-up message from ${userId} to admin:`, error);
                try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ 转发用户 ${userId} 的后续消息时出错: ${error.message}`); } catch {}
            }
            break;
        // --- 【!! 修改结束 !!】 ---

        default:
            await replyWithProtectedLog(ctx, TEXTS.default, {}, "BOT_DEFAULT", false);
    }
});

// --------------------------------------------------
// 7. Vercel 部署设置 (Webhook Handler)
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