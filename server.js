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
app.use(express.json({ limit: '10mb' }));

/* ==============================================================
 *  配置（⚠️ 必须通过环境变量设置 COZE_TOKEN）
 * ============================================================ */
const COZE_TOKEN = process.env.COZE_TOKEN;
const PORT       = process.env.PORT || 3000;

if (!COZE_TOKEN) {
    console.error('❌ 环境变量 COZE_TOKEN 未设置！请在 Render 的 Environment 中添加。');
    // 不 exit，让服务器继续运行以便返回友好错误
}

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

  console.log(`📨 [${new Date().toLocaleTimeString()}] 用户: ${query?.slice(0, 80)}…`);

  // ---- 参数校验 ----
  if (!query) {
    return res.status(400).json({ code: 400, msg: '缺少 query 参数' });
  }
  if (!COZE_TOKEN) {
    return res.status(500).json({ code: 500, msg: '服务器未配置 COZE_TOKEN，请联系管理员' });
  }

  const AUTH_HEAD  = { 'Authorization': 'Bearer ' + COZE_TOKEN };
  const JSON_HEAD  = { ...AUTH_HEAD, 'Content-Type': 'application/json' };

  // 构建 additional_messages
  //   有 conversation_id：Coze 已存储历史，只发当前 query 避免重复
  //   无 conversation_id：发送完整 chat_history 作为上下文
  const additional_messages = [];
  if (conversation_id) {
    // 续接已有对话 —— 只发当前这一条消息
    additional_messages.push({ role: 'user', content: query, content_type: 'text' });
  } else if (Array.isArray(chat_history) && chat_history.length > 0) {
    // 新对话 —— 发送完整历史
    for (const h of chat_history) {
      additional_messages.push({ role: h.role, content: h.content, content_type: 'text' });
    }
  } else {
    // 兜底：手动添加当前 query
    additional_messages.push({ role: 'user', content: query, content_type: 'text' });
  }

  const chatBody = {
    bot_id, user_id,
    stream: false,
    auto_save_history: true,
    additional_messages,
  };
  if (conversation_id) chatBody.conversation_id = conversation_id;

  try {
    /* ---- 第 1 步：发起对话 ---- */
    console.log('  → 第 1 步：发起对话…');
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), 15000);

    let r1, responseText1;
    try {
      r1 = await fetch('https://api.coze.cn/v3/chat', {
        method: 'POST', headers: JSON_HEAD, body: JSON.stringify(chatBody),
        signal: ctrl1.signal,
      });
    } catch (fetchErr) {
      clearTimeout(t1);
      console.error('  ✗ 发起对话网络错误:', fetchErr.message);
      return res.status(502).json({
        code: 502,
        msg: fetchErr.name === 'AbortError' ? 'Coze API 请求超时（第1步）' : '无法连接到 Coze 服务器: ' + fetchErr.message,
      });
    }
    clearTimeout(t1);

    // 安全读取响应文本
    try {
      responseText1 = await r1.text();
    } catch (textErr) {
      console.error('  ✗ 读取响应文本失败:', textErr.message);
      return res.status(502).json({ code: 502, msg: '无法读取 Coze 响应' });
    }

    console.log(`  ← Coze 状态码: ${r1.status}`);
    console.log(`  ← 响应预览: ${responseText1.substring(0, 200)}`);

    // 安全解析 JSON
    let d1;
    try {
      d1 = JSON.parse(responseText1);
    } catch (parseErr) {
      console.error('  ✗ Coze 返回非 JSON:', responseText1.substring(0, 500));
      return res.status(502).json({
        code: 502,
        msg: 'Coze 返回了非 JSON 数据',
        detail: responseText1.substring(0, 300),
      });
    }

    if (!r1.ok || (d1.code !== undefined && d1.code !== 0)) {
      console.error(`  ✗ 发起失败: code=${d1.code} msg=${d1.msg}`);
      return res.status(502).json({ code: d1.code || r1.status, msg: d1.msg || d1.message || '发起对话失败' });
    }

    const chatId    = d1.data.id;
    const newConvId = d1.data.conversation_id || conversation_id;
    console.log(`  ✓ chat_id: ${chatId}`);

    /* ---- 第 2 步：轮询状态 ---- */
    console.log('  → 第 2 步：轮询对话状态…');
    const deadline = Date.now() + 60000;
    let completed = false;

    while (Date.now() < deadline) {
      await sleep(1500);

      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 10000);

      let r2, responseText2;
      try {
        r2 = await fetch(
          `https://api.coze.cn/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${newConvId}`,
          { headers: AUTH_HEAD, signal: ctrl2.signal },
        );
      } catch (fetchErr) {
        clearTimeout(t2);
        console.error('  ✗ 轮询网络错误:', fetchErr.message);
        return res.status(502).json({
          code: 502,
          msg: fetchErr.name === 'AbortError' ? 'Coze API 轮询超时' : '轮询时无法连接 Coze: ' + fetchErr.message,
        });
      }
      clearTimeout(t2);

      try {
        responseText2 = await r2.text();
      } catch (textErr) {
        console.error('  ✗ 读取轮询响应失败:', textErr.message);
        continue; // 重试而非直接失败
      }

      let d2;
      try {
        d2 = JSON.parse(responseText2);
      } catch (parseErr) {
        console.error('  ✗ 轮询返回非 JSON，重试中…');
        continue; // 重试
      }

      if (d2.code !== 0) {
        console.error(`  ✗ 轮询失败: code=${d2.code} msg=${d2.msg}`);
        return res.status(502).json({ code: d2.code, msg: d2.msg || d2.message || '轮询状态失败' });
      }

      const status = d2.data?.status || '';
      console.log(`    status: ${status}`);
      if (status === 'completed') {
        completed = true;
        break;
      }
    }

    if (!completed) {
      console.error('  ✗ 轮询超时（60秒内未完成）');
      return res.status(504).json({ code: 504, msg: 'Coze 对话超时，请稍后重试' });
    }

    /* ---- 第 3 步：获取消息 ---- */
    console.log('  → 第 3 步：获取消息…');
    const ctrl3 = new AbortController();
    const t3 = setTimeout(() => ctrl3.abort(), 10000);

    let r3, responseText3;
    try {
      r3 = await fetch(
        `https://api.coze.cn/v3/chat/message/list?chat_id=${chatId}&conversation_id=${newConvId}`,
        { headers: AUTH_HEAD, signal: ctrl3.signal },
      );
    } catch (fetchErr) {
      clearTimeout(t3);
      console.error('  ✗ 获取消息网络错误:', fetchErr.message);
      return res.status(502).json({
        code: 502,
        msg: fetchErr.name === 'AbortError' ? 'Coze API 获取消息超时' : '获取消息时无法连接 Coze: ' + fetchErr.message,
      });
    }
    clearTimeout(t3);

    try {
      responseText3 = await r3.text();
    } catch (textErr) {
      console.error('  ✗ 读取消息响应失败:', textErr.message);
      return res.status(502).json({ code: 502, msg: '无法读取 Coze 消息响应' });
    }

    let d3;
    try {
      d3 = JSON.parse(responseText3);
    } catch (parseErr) {
      console.error('  ✗ 消息列表非 JSON:', responseText3.substring(0, 500));
      return res.status(502).json({
        code: 502,
        msg: 'Coze 消息列表返回了非 JSON 数据',
        detail: responseText3.substring(0, 300),
      });
    }

    if (d3.code !== 0) {
      console.error(`  ✗ 获取消息失败: code=${d3.code} msg=${d3.msg}`);
      return res.status(502).json({ code: d3.code, msg: d3.msg || d3.message || '获取消息失败' });
    }

    // 提取 assistant 回复
    const messages = d3.data || [];
    let reply = '';

    // 首选：type === 'answer' 且 content 为纯文本的消息
    const answers = messages.filter(m =>
      m.role === 'assistant' &&
      m.type === 'answer' &&
      m.content &&
      !m.content.startsWith('{')
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
      console.error('  ✗ 未提取到回复，原始消息:', JSON.stringify(d3).slice(0, 500));
      return res.status(502).json({ code: 502, msg: '智能体未返回有效回复，请在 Coze 平台检查 Bot 配置' });
    }

    console.log(`  ✓ 回复 ${reply.length} 字: "${reply.slice(0, 60)}…"`);
    res.json({ reply, conversation_id: newConvId });

  } catch (err) {
    console.error('💥 未预期的服务器错误:', err.message, err.stack);
    // 确保始终返回合法 JSON，避免前端 "Unexpected end of JSON input"
    if (!res.headersSent) {
      res.status(500).json({ code: 500, msg: '服务器内部错误: ' + err.message });
    }
  }
});

/* ==============================================================
 *  启动
 * ============================================================ */
app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔋 固锂芯安 已启动');
  console.log('  http://localhost:' + PORT);
  console.log('  🔑 Token 状态: ' + (COZE_TOKEN ? '已设置 ✅' : '未设置 ❌'));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
