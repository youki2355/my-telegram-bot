// api/logger.js
import { Telegraf } from 'telegraf';

// 从环境变量读取配置
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID ? parseInt(process.env.TEST_ACCOUNT_ID, 10) : null;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : null;
const LOGGING_MODE = process.env.LOGGING_MODE || "OFF"; // OFF, ALL, REVIEW_ONLY

let botInstanceForLogging;
if (BOT_TOKEN && TEST_ACCOUNT_ID) {
    botInstanceForLogging = new Telegraf(BOT_TOKEN);
} else {
    if (LOGGING_MODE !== "OFF") {
         console.warn("WARN: LOGGING_MODE is enabled but TEST_ACCOUNT_ID or BOT_TOKEN is not set. Logging disabled.");
    }
}

/**
 * 异步记录消息到测试账号
 * @param {object} ctx - Telegraf 上下文对象
 * @param {string} logType - 日志类型标识
 * @param {boolean} isInReviewPhase - 标记是否处于审核阶段
 * @param {string} [customText] - （可选）要发送的自定义文本
 */
async function logToTestAccount(ctx, logType, isInReviewPhase = false, customText = null) {
    // 1. 检查日志功能是否开启
    if (LOGGING_MODE === "OFF" || !botInstanceForLogging || !TEST_ACCOUNT_ID) {
        return;
    }

    // 2. 检查消息来源是否为测试账号本身
    if (ctx.from && ctx.from.id === TEST_ACCOUNT_ID) {
        return;
    }

    // 3. 根据日志模式决定是否记录
    if (LOGGING_MODE === "REVIEW_ONLY" && !isInReviewPhase) {
        return; // 仅审核模式，且当前不在审核阶段
    }

    // 4. 尝试发送日志
    try {
        const message = ctx.message || ctx.callbackQuery?.message;
        const userId = ctx.from?.id || 'UnknownUser';
        const userName = ctx.from?.first_name || '';
        const userUsername = ctx.from?.username ? `@${ctx.from.username}` : '';
        const timestamp = new Date().toISOString();

        let logPrefix = `[${logType}] User: ${userName}${userUsername}(${userId})`;
        if (ctx.from?.id === ADMIN_ID) {
            logPrefix = `[${logType}] ADMIN (${userId})`;
        }

        // 优先发送自定义文本
        if (customText) {
            await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `[${timestamp}] ${customText}`);
            return;
        }

        // 尝试复制原始消息
        if (message?.message_id && message.chat?.id) {
            await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, logPrefix); // 先发前缀
            await botInstanceForLogging.telegram.copyMessage(TEST_ACCOUNT_ID, message.chat.id, message.message_id);
        }
        // 如果无法复制（例如是 CallbackQuery 或无 message_id），则发送文本描述
        else if (ctx.callbackQuery) {
             await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix} | Button Click: ${ctx.callbackQuery.data}`);
        }
         else if (message?.text) { // 如果是文本消息但无法复制
             await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix} | Text: ${message.text}`);
        } else { // 其他情况
            await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix} | (Non-copyable event)`);
        }

    } catch (error) {
        console.error("Logger Error:", error.message);
        // 记录日志失败不应影响主流程
    }
}

export { logToTestAccount, LOGGING_MODE, STATES as REVIEW_STATES }; // 导出模式和状态
export const REVIEW_ONLY = "REVIEW_ONLY";
export const ALL = "ALL";

// 状态定义（logger 也可能需要知道）
const STATES = {
  AWAITING_RIDDLE_1: 'awaiting_riddle_1',
  AWAITING_RIDDLE_2: 'awaiting_riddle_2',
  AWAITING_ADMIN_REVIEW: 'awaiting_admin_review',
};