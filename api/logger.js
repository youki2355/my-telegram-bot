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

// --- 【关键修正】 ---
// 状态定义（logger 也可能需要知道）
const STATES = {
  AWAITING_RIDDLE_1: 'awaiting_riddle_1',
  AWAITING_RIDDLE_2: 'awaiting_riddle_2',
  AWAITING_ADMIN_REVIEW: 'awaiting_admin_review',
};
// --- 【关键修正结束】 ---


/**
 * 异步记录消息到测试账号
 * ( ... 函数内容 ... )
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

        if (customText) {
            await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `[${timestamp}] ${customText}`);
            return;
        }

        if (message?.message_id && message.chat?.id) {
            await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, logPrefix);
            await botInstanceForLogging.telegram.copyMessage(TEST_ACCOUNT_ID, message.chat.id, message.message_id);
        }
        else if (ctx.callbackQuery) {
             await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix} | Button Click: ${ctx.callbackQuery.data}`);
        }
         else if (message?.text) {
             await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix} | Text: ${message.text}`);
        } else {
            await botInstanceForLogging.telegram.sendMessage(TEST_ACCOUNT_ID, `${logPrefix} | (Non-copyable event)`);
        }

    } catch (error) {
        console.error("Logger Error:", error.message);
    }
}

// --- 【关键修正】 ---
// 在 STATES 定义【之后】再导出
export { logToTestAccount, LOGGING_MODE, STATES as REVIEW_STATES };
export const REVIEW_ONLY = "REVIEW_ONLY";
export const ALL = "ALL";
// --- 【关键修正结束】 ---