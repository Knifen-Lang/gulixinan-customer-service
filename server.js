/**
 * 固锂芯安 — 一体化服务
 *
 *   启动：npm start
 *   访问：http://localhost:3000
 *
 *   部署到 Render / Railway 即可获得公网 URL
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

/* ==============================================================
 *  配置（⚠️ 必须通过环境变量设置 COZE_TOKEN）
 * ============================================================ */
const COZE_TOKEN = process.env.COZE_TOKEN;
if (!COZE_TOKEN) {
    console.error('❌ 错误：未设置环境变量 COZE_TOKEN，请先执行 export COZE_TOKEN=你的令牌');
    process.exit(1);
}

const PORT       = process.env.PORT || 3000;
const AUTH_HEAD  = { 'Authorization': 'Bearer ' + COZE_TOKEN };
const JSON_HEAD  = { ...AUTH_HEAD, 'Content-Type': 'application/json' };

/* ==============================================================
 *  静态文件
 * ============================================================ */
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ==============================================================
 *  工具
 * ============================================================ */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ==============================================================
 *  API 代理 —— /api/chat → Coze v3（三步流程）
 *
 *  第 1 步：POST /v3/chat              发起对话
 *  第 2 步：POST /v3/chat/retrieve      轮询至 completed
 *  第 3 步：GET  /v3/chat/message/list  获取消息
 * ============================================================ */
app.post('/api/chat', async (req, res) => {
  const { bot_id, user_id, query, conversation_id, chat_history } = req.body;

  console.log(`[${new Date().toLocaleTimeString()}] ${user_id}: ${query?.slice(0, 60)}…`);

  // 构建 additional_messages
  const additional_messages = [];
  if (Array.isArray(chat_history)) {
    for (const h of chat_history) {
      additional_messages.push({ role: h.role, content: h.content, content_type: 'text' });
    }
  }
  additional_messages.push({ role: 'user', content: query, content_type: 'text' });

  const chatBody = {
    bot_id, user_id,
    stream: false,
    auto_save_history: true,
    additional_messages,
  };
  if (conversation_id) chatBody.conversation_id = conversation_id;

  try {
    /* ---- 第 1 步：发起对话 ---- */
    const r1 = await fetch('https://api.coze.cn/v3/chat', {
      method: 'POST', headers: JSON_HEAD, body: JSON.stringify(chatBody),
    });
    const d1 = await r1.json();
    if (d1.code !== 0) {
      console.error(`[错误] 发起失败: ${d1.code} ${d1.msg}`);
      return res.status(400).json({ code: d1.code, msg: d1.msg || d1.message });
    }

    const chatId    = d1.data.id;
    const newConvId = d1.data.conversation_id || conversation_id;

    console.log(`[轮询] chat=${chatId}`);

    /* ---- 第 2 步：轮询状态 ---- */
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(1500);

      const r2 = await fetch(
        `https://api.coze.cn/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${newConvId}`,
        { headers: AUTH_HEAD },
      );
      const d2 = await r2.json();
      if (d2.code !== 0) {
        console.error(`[错误] 轮询失败: ${d2.code} ${d2.msg}`);
        return res.status(400).json({ code: d2.code, msg: d2.msg || d2.message });
      }

      const status = d2.data?.status || '';
      console.log(`  → status: ${status}`);
      if (status === 'completed') break;
    }

    /* ---- 第 3 步：获取消息 ---- */
    const r3 = await fetch(
      `https://api.coze.cn/v3/chat/message/list?chat_id=${chatId}&conversation_id=${newConvId}`,
      { headers: AUTH_HEAD },
    );
    const d3 = await r3.json();
    if (d3.code !== 0) {
      console.error(`[错误] 获取消息失败: ${d3.code} ${d3.msg}`);
      return res.status(400).json({ code: d3.code, msg: d3.msg || d3.message });
    }

    // 提取 assistant 回复（优先 type=answer 的纯文本消息）
    const messages = d3.data || [];
    let reply = '';

    // 首选：type === 'answer' 且 content 为纯文本的消息
    const answers = messages.filter(m =>
      m.role === 'assistant' &&
      m.type === 'answer' &&
      m.content &&
      !m.content.startsWith('{')    // 排除 JSON 结构化数据
    );
    if (answers.length > 0) {
      reply = answers.map(m => m.content).join('\n\n');
    } else {
      // 兜底：所有 assistant 消息中非 JSON 的 content
      for (const m of messages) {
        if (m.role === 'assistant' && m.content && !m.content.startsWith('{')) {
          reply += (reply ? '\n\n' : '') + m.content;
        }
      }
    }

    if (!reply) {
      console.error('[错误] 未提取到回复:', JSON.stringify(d3).slice(0, 400));
      return res.status(502).json({ code: 502, msg: '智能体未返回有效回复' });
    }

    console.log(`[成功] 回复 ${reply.length} 字`);
    res.json({ reply, conversation_id: newConvId });

  } catch (err) {
    console.error(`[异常] ${err.message}`);
    res.status(502).json({ code: 502, msg: err.message });
  }
});

/* ==============================================================
 *  启动
 * ============================================================ */
app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔋 固锂芯安 已启动');
  console.log('  http://localhost:' + PORT);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
