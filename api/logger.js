// api/logger.js
import { Telegraf } from 'telegraf';

const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID ? parseInt(process.env.TEST_ACCOUNT_ID, 10) : null;
const BOT_TOKEN = process.env.BOT_TOKEN; // 需要 Bot Token 来初始化一个独立的实例发送日志

let botInstanceForLogging;
if (BOT_TOKEN && TEST_ACCOUNT_ID) {
    // 创建一个轻量级的 Telegraf 实例，仅用于发送日志
    // 注意：不启动 polling 或 webhook
    botInstanceForLogging = new Telegraf(BOT_TOKEN);
} else {
    console.warn("WARN: TEST_ACCOUNT_ID 或 BOT_TOKEN 未设置，日志功能将不可用。");
}

// 定义日志模式
const LOGGING_MODE = process.env.LOGGING_MODE || "OFF"; // 默认为关闭

/**
 * 异步记录消息到测试账号
 * @param {object} ctx - Telegraf 上下文对象，用于获取消息信息
 * @param {string} logType - 日志类型标识，例如 "USER_MESSAGE", "ADMIN_REPLY", "BOT_RESPONSE"
 * @param {boolean} isInReviewPhase - 标记当前交互是否处于审核阶段（用于 REVIEW_ONLY 模式）
 */
async function logToTestAccount(ctx, logType, isInReviewPhase = false) {
    // 1. 检查日志功能是否开启以及配置是否正确
    if (LOGGING_MODE === "OFF" || !botInstanceForLogging || !TEST_ACCOUNT_ID) {
        return;
    }

    // 2. 检查消息来源是否为测试账号本身，如果是则忽略
    if (ctx.from && ctx.from.id === TEST_ACCOUNT_ID) {
        return;
    }

    // 3. 根据日志模式决定是否记录
    if (LOGGING_MODE === "REVIEW_ONLY" && !isInReviewPhase) {
        // 如果是仅审核模式，且当前不在审核阶段，则不记录
        return;
    }

    // 4. 尝试发送日志
    try {
        const message = ctx.message || ctx.callbackQuery?.message; // 获取消息体
        const userId = ctx.from?.id || 'UnknownUser';
        const userName = ctx.from?.first_name || '';
        const userUsername = ctx.from?.username ? `@${ctx.from.username}` : '';
        const timestamp = new Date().toISOString();

        let logPrefix = `[${timestamp}] [${logType}] User: ${userName}${userUsername}(${userId})`;
        if (ctx.from?.id === parseInt(process.env.ADMIN_ID, 10)) {
            logPrefix = `[${timestamp}] [${logType}] ADMIN (${userId})`;
        }

        // 尝试复制原始消息（如果存在）
        if (message?.message_id && message.chat?.id) {
            await botInstanceForLogging.telegram.copyMessage(TEST_ACCOUNT_ID, message.chat.id, message.message_id);
            // 可以在复制的消息后追加一个文本说明来源
            await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, logPrefix);
        }
        // 如果无法复制（例如是 CallbackQuery 或无 message_id），则发送文本描述
        else if (ctx.callbackQuery) {
             await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix}\nButton Click: ${ctx.callbackQuery.data}`);
        }
         else if (ctx.message?.text) { // 如果是文本消息但无法复制
             await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix}\nText: ${ctx.message.text}`);
        } else { // 其他情况，只发送前缀
            await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix}\n(Non-copyable event)`);
        }

    } catch (error) {
        console.error("Logger Error: Failed to send log to test account:", error.message);
        // 记录日志失败不应影响主流程，可以选择静默失败或只在控制台报错
        // 可以考虑给管理员发一次性的错误通知
        // try { await botInstanceForLogging.telegram.sendMessage(ADMIN_ID, `⚠️ 日志系统错误: ${error.message}`); } catch {}
    }
}

// 导出日志函数
export { logToTestAccount };